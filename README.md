# Golden ID prototype

A dependency-free, local MVP demonstrating identity-field consistency checks and a holder-authorized retrieval API. It **does not verify documents with UIDAI, Income Tax/Protean, ECI, DigiLocker, or any government system** and must not be presented as a government credential.

## Run

Requires Node.js 18+.

```sh
npm start
```

Open `http://localhost:3000`. Run tests with `npm test`.

The holder retrieval screen is at `http://localhost:3000/verify.html`. A production QR should encode a short-lived, digitally signed verification URL; the prototype does not generate a QR image because an unsigned static QR would leak or falsely imply trust.

## API demo

`POST /api/v1/applications` accepts consent and exactly one Birth Certificate, Aadhaar Card, PAN Card, Passport and Voter ID record. Shared identity fields must match; matching records get a random Golden ID and bearer token. Retrieve the minimized record with:

```sh
curl -H "Authorization: Bearer HOLDER_TOKEN" http://localhost:3000/api/v1/cards/GOLDEN_ID
```

Data is kept only in memory and disappears on restart. Before production, replace this with encrypted storage, real authentication, signed QR payloads, revocation, audit logs, rate limits, key management, and formally approved government integrations.
