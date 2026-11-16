#!/usr/bin/env python3
"""Read-only HTTPS acceptance for the separately deployed empty test site.

Run on the ECS host after its HTTPS reverse proxy is ready. Credentials remain
in the root-only bootstrap file and never become arguments or log output.
"""

import argparse
import http.cookiejar
import json
import os
import re
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser


ORIGIN = "https://www.treefund.asia"
INITIAL_LOGIN = "/opt/jiashu-test/initial-login.txt"
OWNER_ID = "treefund-test-owner"
OWNER_EMAIL = "admin@treefund.asia"
MAX_RESPONSE_BYTES = 4 * 1024 * 1024


class VerificationFailure(Exception):
    def __init__(self, label, status=None):
        self.label = label
        self.status = status


def require(condition, label, status=None):
    if not condition:
        raise VerificationFailure(label, status)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, target):
        return None


class HiddenForm(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tokens = []

    def handle_starttag(self, tag, attributes):
        values = dict(attributes)
        if tag.lower() == "input" and values.get("name") == "csrf" and values.get("type") == "hidden":
            self.tokens.append(values.get("value", ""))


class Browser:
    def __init__(self):
        self.cookies = http.cookiejar.CookieJar()
        # HTTPSHandler's default context verifies the public certificate and
        # hostname. Redirects are disabled, including redirects to other hosts.
        self.opener = urllib.request.build_opener(
            NoRedirect(), urllib.request.HTTPCookieProcessor(self.cookies)
        )

    def request(self, path, label, method="GET", form=None, headers=None):
        require(path.startswith("/") and not path.startswith("//"), "request_path")
        request_headers = {"Accept": "text/html, application/json", "User-Agent": "Jiashu-Selfhost-Acceptance/1"}
        request_headers.update(headers or {})
        body = None
        if form is not None:
            body = urllib.parse.urlencode(form).encode("utf-8")
            request_headers["Content-Type"] = "application/x-www-form-urlencoded"
            request_headers["Origin"] = ORIGIN
        request = urllib.request.Request(ORIGIN + path, data=body, headers=request_headers, method=method)
        try:
            response = self.opener.open(request, timeout=15)
        except urllib.error.HTTPError as response_error:
            response = response_error
        except Exception:
            raise VerificationFailure(label + "_connection") from None
        try:
            # Also extract from non-followed 303 responses. Password and session
            # contents are never included in failure messages.
            self.cookies.extract_cookies(response, request)
            status_code = response.getcode()
            payload = response.read(MAX_RESPONSE_BYTES + 1)
            require(len(payload) <= MAX_RESPONSE_BYTES, label + "_response_size", status_code)
            return status_code, response.headers, payload
        except VerificationFailure:
            raise
        except Exception:
            raise VerificationFailure(label + "_response") from None
        finally:
            response.close()


def parsed_json(result, expected_status, label):
    status_code, headers, payload = result
    require(status_code == expected_status, label + "_status", status_code)
    require("application/json" in headers.get("Content-Type", "").lower(), label + "_content_type", status_code)
    try:
        value = json.loads(payload)
    except Exception:
        raise VerificationFailure(label + "_json", status_code) from None
    require(isinstance(value, dict), label + "_json_shape", status_code)
    return value


def read_credentials():
    descriptor = None
    try:
        descriptor = os.open(INITIAL_LOGIN, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        metadata = os.fstat(descriptor)
        require(stat.S_ISREG(metadata.st_mode) and stat.S_IMODE(metadata.st_mode) == 0o600, "credential_file_permissions")
        require(metadata.st_uid == 0, "credential_file_owner")
        with os.fdopen(descriptor, "r", encoding="utf-8") as source:
            descriptor = None
            content = source.read(4097)
        require(len(content) <= 4096, "credential_file_size")
        fields = {}
        for line in content.splitlines():
            for prefix in ("Public origin: ", "Username: ", "Initial password: "):
                if line.startswith(prefix):
                    require(prefix not in fields, "credential_file_fields")
                    fields[prefix] = line[len(prefix):]
        require(fields.get("Public origin: ") == ORIGIN, "credential_origin")
        # Existing bootstrap files retain their legacy administrator username.
        # Validate that provenance, then use the fixed owner email for login.
        require(fields.get("Username: ") == "admin", "credential_username")
        require(12 <= len(fields.get("Initial password: ", "")) <= 256, "credential_password")
        return OWNER_EMAIL, fields["Initial password: "]
    except VerificationFailure:
        raise
    except Exception:
        raise VerificationFailure("credential_file") from None
    finally:
        if descriptor is not None:
            os.close(descriptor)


def csrf_form(browser, path, label):
    status_code, headers, payload = browser.request(path + "?return_to=%2Fhealth", label)
    require(status_code == 200, label + "_status", status_code)
    require("text/html" in headers.get("Content-Type", "").lower(), label + "_content_type", status_code)
    require("no-store" in headers.get("Cache-Control", "").lower(), label + "_cache", status_code)
    parser = HiddenForm()
    try:
        parser.feed(payload.decode("utf-8"))
    except Exception:
        raise VerificationFailure(label + "_html", status_code) from None
    require(len(parser.tokens) == 1 and re.fullmatch(r"[A-Za-z0-9_.-]{40,1500}", parser.tokens[0]), label + "_csrf", status_code)
    csrf_cookies = [cookie for cookie in browser.cookies if cookie.name == "__Host-jso-csrf"]
    require(len(csrf_cookies) == 1, label + "_csrf_cookie", status_code)
    csrf = csrf_cookies[0]
    require(csrf.secure and csrf.path == "/" and csrf.has_nonstandard_attr("HttpOnly"), label + "_csrf_cookie_attributes", status_code)
    require(csrf.value == parser.tokens[0], label + "_csrf_binding", status_code)
    return parser.tokens[0]


def verify(expected_commit):
    email, password = read_credentials()
    anonymous = Browser()
    readiness = parsed_json(anonymous.request("/_selfhost/healthz", "readiness"), 200, "readiness")
    require(readiness.get("ok") is True and readiness.get("commitSha") == expected_commit, "readiness_commit")
    schema = readiness.get("schema")
    require(isinstance(schema, dict) and schema.get("schemaReady") is True and schema.get("pending") == 0
            and isinstance(schema.get("applied"), int) and schema["applied"] > 0 and schema["applied"] == schema.get("total"), "readiness_schema")
    parsed_json(anonymous.request("/api/session", "anonymous_session"), 401, "anonymous_session")
    parsed_json(anonymous.request("/api/session", "spoofed_identity", headers={
        "oai-authenticated-user-id": OWNER_ID,
        "oai-authenticated-user-email": OWNER_EMAIL,
        "x-authenticated-user-id": OWNER_ID,
    }), 401, "spoofed_identity")
    parsed_json(anonymous.request("/api/admin/users", "anonymous_admin_users", headers={
        "X-Page-Owner": OWNER_ID,
    }), 401, "anonymous_admin_users")

    browser = Browser()
    csrf = csrf_form(browser, "/signin-with-chatgpt", "login_form")
    status_code, headers, _ = browser.request("/signin-with-chatgpt", "login", method="POST", form={
        "email": email, "password": password, "csrf": csrf, "return_to": "/health",
    })
    password = None
    require(status_code == 303, "login_status", status_code)
    require(headers.get("Location") == "/health", "login_redirect", status_code)
    session_cookies = [cookie for cookie in browser.cookies if cookie.name == "__Host-jso-session"]
    require(len(session_cookies) == 1, "session_cookie")
    session_cookie = session_cookies[0]
    require(session_cookie.secure and session_cookie.path == "/" and not session_cookie.domain_specified
            and session_cookie.has_nonstandard_attr("HttpOnly")
            and session_cookie.get_nonstandard_attr("SameSite", "").lower() == "lax", "session_cookie_attributes")
    require(isinstance(session_cookie.expires, int) and 29 * 86400 <= session_cookie.expires - time.time() <= 31 * 86400,
            "persistent_session_cookie")
    replay_cookie = session_cookie.name + "=" + session_cookie.value
    identity = parsed_json(browser.request("/api/session", "authenticated_session"), 200, "authenticated_session")
    require(identity.get("userId") == OWNER_ID and identity.get("email") == OWNER_EMAIL
            and identity.get("isOwner") is True, "authenticated_owner")
    status_code, headers, html = browser.request("/settings/users", "admin_users_page")
    require(status_code == 200 and "text/html" in headers.get("Content-Type", "").lower()
            and b"<!doctype html>" in html.lower(), "admin_users_page_html", status_code)
    admin_users = parsed_json(browser.request("/api/admin/users", "admin_users", headers={
        "X-Page-Owner": OWNER_ID,
    }), 200, "admin_users")
    require(admin_users.get("currentUserId") == OWNER_ID, "admin_users_current_user")
    public_user_fields = {"id", "email", "status", "revision", "isAdmin", "createdAt", "updatedAt", "lastLoginAt"}
    users = admin_users.get("users")
    require(isinstance(users, list) and all(isinstance(user, dict) and set(user) <= public_user_fields for user in users), "admin_users_public_fields")
    require(isinstance(admin_users.get("csrfToken"), str) and bool(admin_users["csrfToken"]), "admin_users_csrf")
    status_code, headers, html = browser.request("/health", "health_page")
    require(status_code == 200 and "text/html" in headers.get("Content-Type", "").lower()
            and b"<!doctype html>" in html.lower(), "health_page_html", status_code)
    require(b"Object.defineProperty(window,'__JIASHU_PAGE_SESSION__'" in html
            and b"value:Object.freeze(" in html, "server_verified_page_session")
    catalog = parsed_json(browser.request("/api/health/nutrition/foods?limit=1", "food_catalog"), 200, "food_catalog")
    require(isinstance(catalog.get("foods"), list) and len(catalog["foods"]) == 1
            and isinstance(catalog.get("total"), int) and catalog["total"] > 0
            and isinstance(catalog.get("sources"), list) and len(catalog["sources"]) >= 2, "food_catalog_data")

    csrf = csrf_form(browser, "/signout-with-chatgpt", "logout_form")
    status_code, headers, _ = browser.request("/signout-with-chatgpt", "logout", method="POST", form={
        "csrf": csrf, "return_to": "/health",
    })
    require(status_code == 303 and headers.get("Location") == "/health", "logout_status", status_code)
    require(not any(cookie.name == "__Host-jso-session" for cookie in browser.cookies), "logout_cookie")
    parsed_json(browser.request("/api/session", "logged_out_session"), 401, "logged_out_session")
    parsed_json(Browser().request("/api/session", "revoked_session_replay", headers={"Cookie": replay_cookie}), 401, "revoked_session_replay")
    replay_cookie = None
    parsed_json(browser.request("/api/admin/users", "logged_out_admin_users", headers={
        "X-Page-Owner": OWNER_ID,
    }), 401, "logged_out_admin_users")
    return {"ok": True, "commitSha": expected_commit, "checks": ["https", "schema", "identity_isolation", "login", "persistent_cookie", "owner", "admin_user_view", "health_page", "server_verified_page_session", "food_catalog", "logout", "revoked_session_replay"]}


def main():
    parser = argparse.ArgumentParser(description="Verify the deployed HTTPS test site without writing business records.")
    parser.add_argument("--expected-commit", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-f0-9]{40}", args.expected_commit):
        parser.error("--expected-commit must be a full lowercase 40-character commit SHA")
    try:
        result = verify(args.expected_commit)
    except VerificationFailure as error:
        result = {"ok": False, "check": error.label}
        if error.status is not None:
            result["status"] = error.status
        print(json.dumps(result, separators=(",", ":")))
        return 1
    except Exception:
        print('{"ok":false,"check":"verification_failed"}')
        return 1
    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
