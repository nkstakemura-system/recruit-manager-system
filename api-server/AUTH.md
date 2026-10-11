# Authentication setup

Code preparation only. Before rollout, validate mobile authentication on Android/iOS devices and apply the separately reviewed candidate-field migration. No deployment is performed by this change.

Set api-server environment variables externally:
- NODE_ENV: production on the server.
- AUTH_USERNAME: shared internal account name.
- AUTH_PASSWORD_HASH: bcrypt hash. Generate locally with bcryptjs; use cost 12 or higher. Never commit the password or hash.
- AUTH_SESSION_SECRET: random secret of at least 32 bytes.
- MEETING_API_TOKEN: optional random secret of at least 32 bytes, for the future meeting backend only.
- ALLOWED_ORIGINS: comma-separated exact origins, including the application's own HTTPS origin. No wildcard fallback.
- DATABASE_URL and PORT: existing server settings.

.env.example contains variable names only. .env and .env.* are ignored, except .env.example.

Browser authentication uses an HS256 signed JWT in an HttpOnly cookie. Production cookies have Secure, SameSite=Lax, Path=/ and a __Host- name. Expiry is eight hours. JWT contents contain identity and a credential-version fingerprint, never applicant information or passwords. Session cookies remain valid across restarts with the same configuration. Secret or account credential changes invalidate them. Logout removes the browser cookie; a previously copied cookie remains valid until expiry or configuration rotation. There is no session DB or revocation store.

Web and mobile login share an account limit of ten attempts per fifteen minutes. This in-memory budget resets on restart and is per server instance. It does not trust proxy/client IP headers. API reads/writes are not rate-limited by this mechanism.

Every data API requires either a valid browser cookie session or a mobile user JWT. Cookie-authenticated POST/PUT/PATCH/DELETE and browser login/logout require an Origin matching ALLOWED_ORIGINS. Native mobile Bearer requests use JWT verification instead of cookie Origin checks. Mobile login rejects browser Origin/Fetch-Metadata headers; CORS restrictions remain enabled. Origins are not authentication.

GET /api/meeting/hr-summary accepts browser sessions and mobile user JWTs, and additionally accepts MEETING_API_TOKEN for server-to-server access only. MEETING_API_TOKEN grants no candidates/expenses/write access. Browser-origin/Fetch-Metadata requests using this fixed token are rejected. Never use VITE_ variables, JS bundles or mobile bundles for this token. A production read must authenticate; the former localhost-only guard is removed.

Web startup calls auth/me before mounting management screens. Every data fetch includes cookies. A 401 unmounts management screens and returns to login. Server responses use no-store and API errors remain JSON.

The mobile app is Expo SDK 54 / React Native, not a WebView. POST /api/auth/mobile/login accepts username/password and returns an eight-hour user JWT with type=user, client=mobile and audience=recruit-mobile; it sets no cookie. Invalid credentials return the same 401 response. GET /api/auth/me accepts this JWT. Protected mobile requests send Authorization: Bearer with credentials omitted. Browser cookie JWTs and mobile JWTs cannot substitute for one another. Do not embed MEETING_API_TOKEN.

The mobile client stores the JWT and expiry only through Expo SecureStore, with WHEN_UNLOCKED_THIS_DEVICE_ONLY on iOS. Startup verifies a stored session before mounting recruitment screens. Expiry, API 401 and logout remove the stored session and return to login; pending responses are discarded after logout. Logout is local and does not revoke a copied JWT. The SecureStore Expo plugin is configured; native builds must include the dependency. Expo Web is not supported by this mobile authentication flow; use react-app for browser access.

Tests: npm test in api-server and recruit-mobile; npm run typecheck in recruit-mobile. API tests invoke middleware/handlers against fake requests and a fake DB. Mobile tests inject storage and transport doubles. Tests open no HTTP listener, contact no public API and execute no real SQL.