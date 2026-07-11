# Tickerworld

Tickerworld is a calm browser exploration game set in an endless pastel landscape of living crypto chart monuments.

## Development

```sh
npm install
npm run dev
```

Use `?data=sim` for deterministic simulated market data and `?debug=1` for runtime diagnostics.

## X news feed

Tickerworld polls its server-side `/api/news` function for recent posts from
[@DeItaone](https://x.com/DeItaone). Create a paid X developer app, add its bearer token as the
server-only `X_BEARER_TOKEN` environment variable in Vercel (Production, Preview, and Development
as needed), and redeploy. Never expose this value through a `VITE_`-prefixed variable.
Set a spending limit and balance alert in the X Developer Console before enabling production reads.

Without the token, the game automatically uses clearly labelled fictional demo headlines. Use
`?news=sim` to force that deterministic demo; it emits one item immediately and another every two
minutes. For local testing of the live function, copy `.env.example` to an ignored `.env.local`, add
the token, and run `vercel dev`.
