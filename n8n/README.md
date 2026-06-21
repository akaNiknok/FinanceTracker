# n8n workflows

Reference exports of the n8n workflows that drive FinanceTracker. The bot is a private Telegram client: it parses free-text messages into transactions (Gemini + structured output parser), POSTs them to the GAS Web App, and supports `/sync` to refresh Categories/Accounts. A separate error-handler workflow reports failures back to Telegram.

| File | Workflow | Purpose |
| --- | --- | --- |
| `Finance Tracker.json` | Finance Tracker | Telegram trigger → auth check → parse → POST transaction; `/sync` pulls reference data into n8n Data Tables. |
| `Finance Tracker - Error Handler.json` | Finance Tracker - Error Handler | `errorWorkflow` for the above; fetches the failed execution and replies to the user on Telegram. |

## Redacted secrets (replace before importing)

These exports are sanitized per the repo's no-credentials-in-git rule. Restore the real values in the n8n editor after import:

- `<<APPS_SCRIPT_WEB_APP_URL>>` — the GAS Web App deployment URL (treated as a secret; see `MEMORY.md`). Used by the **Fetch from Apps Script** and **Add Transaction** HTTP nodes in `Finance Tracker.json`.
- `<<N8N_API_KEY>>` — the n8n public API key, used by the **HTTP Request** node in the error handler to read execution data.

Credential *references* (Telegram, Google Gemini) are kept as n8n credential IDs/names only — the actual secrets live in n8n's credential store, not in these files. Import into the same n8n instance (or recreate the credentials) to reconnect them.
