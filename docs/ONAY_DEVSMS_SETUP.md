# Onay SMS login: DevSMS

The verified provider contract is [DevSMS API v1](https://devsms.uz/docs/api/agents.md), with the [public documentation](https://devsms.uz/docs/api). This integration uses the versioned SMS endpoint and its universal sign-in OTP object. It does not use a similarly named SDK or the legacy PHP endpoint. An accepted provider response does not prove handset delivery.

Configure only the API server. Create a key in the DevSMS dashboard with `sms:send`; never send its value through chat, commit it, embed it in the app, or log it. Set `DEVSMS_API_KEY` through the deployment secret facility or a private server env file. The Compose recipe passes it to the API service only, not the database or migration service.

```dotenv
TEZJET_SMS_PROVIDER=devsms
DEVSMS_API_KEY=<set privately>
TEZJET_SMS_SERVICE_NAME=Onay
TEZJET_SMS_TIMEOUT_MS=8000
TEZJET_SMS_SEND_ENABLED=false
```

Keep sending disabled until the intended recipient and manual test are ready. Setting a key alone does not enable it. For the planned acceptance test, change `TEZJET_SMS_SEND_ENABLED` to `true` privately on the test server and restart that API. Do not enable it in CI. Production cannot use demo codes. With no configured sender, the API fails closed before saving a phone challenge. Nonproduction's existing demo flow stays available when no real provider is selected; choosing DevSMS suppresses demo-code output in every environment. The first release limits this real delivery path to Uzbekistan numbers.

Each admitted send gets a fresh delivery UUID, stored with the OTP and supplied as the provider idempotency key. One call is made, with a bounded timeout and no automatic retries or redirects. No provider response body, phone, code, token or message identifier is included in public error diagnostics. A definitive rejection discards only the matching delivery challenge, not a newer resend; abuse budgets are not refunded. On an unknown outcome, the bounded challenge remains usable if the recipient actually received its code, but the request is not reported as a confirmed send and no automatic additional SMS is issued.

Apply migrations 0014 and 0015 with the existing runner before starting the updated API. 0014 adds a nullable delivery identity to OTP challenges. 0015 repairs the older journal ordering that could skip0013 on an existing0012 database; it restores the same permanent request fences without rewriting existing receipts, orders or applied history. Previous migrations stay intact. Draining old API instances before activating delivery is required: older binaries do not enforce the configured-provider boundary and must not continue serving auth requests after rollout. Do not revert to those binaries while live SMS login is active.

Automatic tests use synthetic provider responses and isolated PostgreSQL; they must not use a real DevSMS key or spend the reported two free messages. Do not copy provider retry recommendations into an automatic resend loop. Provider acceptance, delivery, account permissions, balance and SMS quota are separate observations.

## Two-message manual acceptance

Prerequisites: a reachable test API, configured secrets, an intended recipient authorized by the owner, current database migration, and explicit approval to send these messages. No paid top-up or server purchase is part of this change.

1. Request one OTP from the actual passenger app, note API outcome without recording the code/token, verify receipt on the intended phone, enter it, confirm login, and verify one-time use. Check the provider dashboard for exactly one message.
2. If the first case succeeds, request the second OTP for the intended driver account and verify actual receipt/login. A resend gesture, timeout or repeated automation must not spend another message silently.

If an outcome is unknown, stop and inspect its existing provider record before any new send. Do not run destructive failure or repeated-delivery experiments against the two-message quota. Re-disable sending after a limited manual test if the server is not ready for ongoing use.

A passing adapter/CI is not a successful real-SMS test. No message has been sent by this implementation task; physical login, HTTPS deployment, legal review and release acceptance remain separate gates.
