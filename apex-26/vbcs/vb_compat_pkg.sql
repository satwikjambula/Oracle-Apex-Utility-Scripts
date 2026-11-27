--------------------------------------------------------------------------------
-- vb_compat_pkg.sql  —  server side for vbUtils.js (APEX 26.x)
-- Version 1.0.0  |  MIT  |  2026 Satwik
--
-- 1. VB_REST_ENDPOINTS  : allowlist the browser can call by key (VB "service endpoints")
-- 2. VB_COMPAT_PKG
--      ajax_rest_proxy  -> AJAX Callback "VB_REST_PROXY"  (Actions.callRest)
--      ajax_get_url     -> AJAX Callback "VB_GET_URL"     (Actions.navigateToPage)
--
-- Setup (per application, or on Page 0):
--   Process: Type = Execute Code, Point = AJAX Callback, Name = VB_REST_PROXY
--            Code: vb_compat_pkg.ajax_rest_proxy;
--   Process: Type = Execute Code, Point = AJAX Callback, Name = VB_GET_URL
--            Code: vb_compat_pkg.ajax_get_url;
--   Web Credentials: Shared Components > Workspace Utilities > Web Credentials
--   Network ACL / workspace ACL (26.2) must allow the target hosts.
--
-- Why a proxy: in VBCS the browser calls services through VB's proxy with service
-- connections. Calling them straight from APEX JavaScript would expose tokens and
-- invite SSRF if the URL came from the client. Here the client sends only a key.
--------------------------------------------------------------------------------

create table vb_rest_endpoints (
  endpoint_key          varchar2(200)  not null constraint vb_rest_endpoints_pk primary key, -- e.g. 'hr/getEmployee'
  http_method           varchar2(10)   default 'GET' not null
                          constraint vb_rest_endpoints_m_ck check (http_method in ('GET','POST','PUT','PATCH','DELETE')),
  base_url              varchar2(1000) not null,   -- https://fa-xxxx.oraclecloud.com
  url_path              varchar2(2000) not null,   -- /hcmRestApi/resources/11.13.18.05/emps/{id}
  credential_static_id  varchar2(255),             -- APEX Web Credential static id
  authorization_scheme  varchar2(255),             -- optional APEX authorization scheme name
  allow_query_params    varchar2(1)    default 'N' not null constraint vb_rest_endpoints_q_ck check (allow_query_params in ('Y','N')),
  allowed_headers       varchar2(1000),            -- comma list the client may set, e.g. 'Prefer,If-Match'
  enabled               varchar2(1)    default 'Y' not null constraint vb_rest_endpoints_e_ck check (enabled in ('Y','N')),
  description           varchar2(4000)
);

-- Example rows (adjust host / credential):
-- insert into vb_rest_endpoints (endpoint_key, http_method, base_url, url_path, credential_static_id, allow_query_params)
-- values ('fusion/getInvoices', 'GET', 'https://fa-xxxx.oraclecloud.com', '/fscmRestApi/resources/11.13.18.05/invoices', 'FUSION_CRED', 'Y');
-- insert into vb_rest_endpoints (endpoint_key, http_method, base_url, url_path, credential_static_id, allowed_headers)
-- values ('fusion/updateInvoice', 'PATCH', 'https://fa-xxxx.oraclecloud.com', '/fscmRestApi/resources/11.13.18.05/invoices/{InvoiceId}', 'FUSION_CRED', 'If-Match');

create or replace package vb_compat_pkg authid definer as
  -- Request (apex_application.g_x01..x04): endpoint key, uriParams JSON, body JSON, headers JSON
  -- Response JSON: { ok, status, headers:{...}, body:"<raw response text>", error }
  procedure ajax_rest_proxy;

  -- Request: g_x01 page, g_x02 params JSON {"P10_ID":7}, g_x03 clear cache (optional)
  -- Response JSON: { url } or { error }
  procedure ajax_get_url;
end vb_compat_pkg;
/

create or replace package body vb_compat_pkg as

  type t_params is table of varchar2(32767) index by varchar2(255);

  -- Flattens a one-level JSON object into name -> string value.
  function parse_params(p_json in varchar2) return t_params is
    l_result t_params;
    l_obj    json_object_t;
    l_keys   json_key_list;
  begin
    if p_json is null then
      return l_result;
    end if;
    l_obj  := json_object_t.parse(p_json);
    l_keys := l_obj.get_keys;
    if l_keys is not null then
      for i in 1 .. l_keys.count loop
        l_result(l_keys(i)) := l_obj.get_string(l_keys(i));
      end loop;
    end if;
    return l_result;
  end parse_params;

  function is_listed(p_list in varchar2, p_value in varchar2) return boolean is
  begin
    return p_list is not null
       and instr(',' || upper(replace(p_list, ' ')) || ',', ',' || upper(p_value) || ',') > 0;
  end is_listed;

  procedure write_error(p_status in number, p_message in varchar2) is
  begin
    apex_json.open_object;
    apex_json.write('ok', false);
    apex_json.write('status', p_status);
    apex_json.write('error', p_message);
    apex_json.close_object;
  end write_error;

  procedure ajax_rest_proxy is
    l_ep        vb_rest_endpoints%rowtype;
    l_uri       t_params;
    l_hdr       t_params;
    l_path      varchar2(32767);
    l_query     varchar2(32767);
    l_key       varchar2(255);
    l_response  clob;
    l_status    number;
  begin
    begin
      select * into l_ep
        from vb_rest_endpoints
       where endpoint_key = apex_application.g_x01
         and enabled = 'Y';
    exception
      when no_data_found then
        write_error(404, 'Unknown endpoint');   -- don't echo the key back
        return;
    end;

    if l_ep.authorization_scheme is not null
       and not apex_authorization.is_authorized(l_ep.authorization_scheme) then
      write_error(403, 'Not authorized');
      return;
    end if;

    -- {placeholders} in the path come from uriParams; the rest become query params if allowed
    l_uri  := parse_params(apex_application.g_x02);
    l_path := l_ep.url_path;
    l_key  := l_uri.first;
    while l_key is not null loop
      if instr(l_path, '{' || l_key || '}') > 0 then
        l_path := replace(l_path, '{' || l_key || '}', utl_url.escape(l_uri(l_key), true, 'AL32UTF8'));
      elsif l_ep.allow_query_params = 'Y' then
        l_query := l_query || case when l_query is null then '?' else '&' end
                || utl_url.escape(l_key, true, 'AL32UTF8') || '=' || utl_url.escape(l_uri(l_key), true, 'AL32UTF8');
      end if;
      l_key := l_uri.next(l_key);
    end loop;

    if regexp_like(l_path, '\{[^}]+\}') then
      write_error(400, 'Missing uriParams for path');
      return;
    end if;

    -- Only allowlisted headers from the client; Authorization comes from the credential.
    apex_web_service.set_request_headers(p_name_01 => 'Content-Type', p_value_01 => 'application/json', p_reset => true);
    l_hdr := parse_params(apex_application.g_x04);
    l_key := l_hdr.first;
    while l_key is not null loop
      if is_listed(l_ep.allowed_headers, l_key) then
        apex_web_service.set_request_headers(p_name_01 => l_key, p_value_01 => l_hdr(l_key), p_reset => false);
      end if;
      l_key := l_hdr.next(l_key);
    end loop;

    l_response := apex_web_service.make_rest_request(
                    p_url                  => l_ep.base_url || l_path || l_query,
                    p_http_method          => l_ep.http_method,
                    p_body                 => case when l_ep.http_method <> 'GET' then apex_application.g_x03 end,
                    p_credential_static_id => l_ep.credential_static_id);
    l_status := apex_web_service.g_status_code;

    apex_json.open_object;
    apex_json.write('ok', l_status between 200 and 299);
    apex_json.write('status', l_status);
    apex_json.open_object('headers');
    for i in 1 .. apex_web_service.g_headers.count loop
      -- skip cookies; they belong to the server-to-server session
      if lower(apex_web_service.g_headers(i).name) not in ('set-cookie', 'set-cookie2') then
        apex_json.write(apex_web_service.g_headers(i).name, apex_web_service.g_headers(i).value);
      end if;
    end loop;
    apex_json.close_object;
    apex_json.write('body', l_response);
    apex_json.close_object;
  exception
    when others then
      apex_debug.error('vb_compat_pkg.ajax_rest_proxy %s: %s', apex_application.g_x01, sqlerrm);
      write_error(500, 'Proxy error - see APEX debug log');
  end ajax_rest_proxy;

  procedure ajax_get_url is
    l_params t_params;
    l_items  varchar2(32767);
    l_values varchar2(32767);
    l_key    varchar2(255);
    l_val    varchar2(32767);
  begin
    l_params := parse_params(apex_application.g_x02);
    l_key := l_params.first;
    while l_key is not null loop
      if not regexp_like(l_key, '^[A-Za-z0-9_$]+$') then
        raise_application_error(-20001, 'Invalid item name');
      end if;
      l_val := l_params(l_key);
      -- APEX URL values containing commas must be wrapped in backslashes
      if instr(l_val, ',') > 0 then
        l_val := '\' || l_val || '\';
      end if;
      l_items  := l_items  || case when l_items  is not null then ',' end || l_key;
      l_values := l_values || case when l_values is not null then ',' end || l_val;
      l_key := l_params.next(l_key);
    end loop;

    apex_json.open_object;
    apex_json.write('url', apex_page.get_url(
                             p_page        => apex_application.g_x01,
                             p_items       => l_items,
                             p_values      => l_values,
                             p_clear_cache => apex_application.g_x03));
    apex_json.close_object;
  exception
    when others then
      apex_debug.error('vb_compat_pkg.ajax_get_url: %s', sqlerrm);
      apex_json.open_object;
      apex_json.write('error', 'Could not build URL');
      apex_json.close_object;
  end ajax_get_url;

end vb_compat_pkg;
/
