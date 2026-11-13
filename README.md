# n8n retry effects

[![test](https://github.com/feversoul/n8n-retry-effects/actions/workflows/test.yml/badge.svg)](https://github.com/feversoul/n8n-retry-effects/actions/workflows/test.yml)

When you retry a failed n8n execution, which calls to the outside go out a second time? This repo measures it on a real n8n, by counting what the receiving service got, and ships a sub-workflow, **Guarded call**, that keeps every item at one call however often the execution is retried.

Everything here was run on n8n 2.47.7, in regular mode on SQLite and in queue mode (main, one worker, Redis, PostgreSQL). Both gave the same numbers. The service is a stand-in that counts requests; no real provider was called.

| Question                                                         | Answer in this repo                                                                                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One call reached the service, then failed or timed out. Retry?   | The action happens twice. Only a refusal that wrote nothing (a clean 503) is harmless.                                                                                    |
| A node with several items fails on item 3. Are 1 and 2 repeated? | Yes, and so are 4 and 5: the HTTP Request node had already sent all five before it failed. The retry sends all five again.                                                |
| Public API retry, `loadWorkflow` true or false, versus the UI?   | Same restart point in all of them: the failed node. `loadWorkflow` only picks which definition of that node runs. The API also takes an `Idempotency-Key` header.         |
| A failed Execute Sub-workflow node?                              | The whole sub-workflow runs again, its completed steps included.                                                                                                          |
| Retry On Fail on the node versus retrying the execution?         | Same repeats, but inside one execution that ends green.                                                                                                                   |
| How do you guard it?                                             | A check node in front of the call does not help, the retry skips it. Put check and call in a sub-workflow: that runs again as a whole. See [Guarded call](#guarded-call). |

## What was measured

The lab workflow (`workflows/9-lab.json`) makes the same call for N items in several ways. Before each run the test tells the stand-in which item to fail and how. Then it retries the failed execution and reads the stand-in's log. The columns show the item numbers in the order the service received them.

Without a guard:

| Case                                                               | First run | Retry                | Times each item was done   |
| ------------------------------------------------------------------ | --------- | -------------------- | -------------------------- |
| One call, service does the work, answers 500                       | 1         | 1                    | 2                          |
| One call, service does the work, answers after n8n's timeout       | 1         | 1                    | 2                          |
| One call, service answers 503 and does nothing                     | 1         | 1                    | 1                          |
| 5 items in one HTTP Request node, item 3 fails                     | 1 2 3 4 5 | 1 2 3 4 5            | 2 each                     |
| Same, retried by API `loadWorkflow: true`, API without a body      | 1 2 3 4 5 | 1 2 3 4 5            | 2 each                     |
| Same, retried by the editor: "original" and "currently saved"      | 1 2 3 4 5 | 1 2 3 4 5            | 2 each                     |
| Same, the same execution retried twice                             | 1 2 3 4 5 | 1 2 3 4 5, 1 2 3 4 5 | 3 each                     |
| Same, the API retry sent 3 times with one `Idempotency-Key` header | 1 2 3 4 5 | 1 2 3 4 5            | 2 each (one retry started) |
| Same, with Retry On Fail (3 tries) on the node, no execution retry | 1 2 3 4 5 | 1 2 3 4 5 (same run) | 2 each, run ends green     |
| Loop Over Items, batch size 1, item 3 fails                        | 1 2 3     | 3 4 5                | item 3 twice, others once  |
| The call inside a sub-workflow, behind a step that completes       | 1 2 3 4 5 | 1 2 3 4 5            | 2 each, the step ran twice |
| A ledger check and claim in front of the call, same workflow       | 1 2 3 4 5 | 1 2 3 4 5            | 2 each                     |
| The service honours the `Idempotency-Key` of the call              | 1 2 3 4 5 | 1 2 3 4 5            | 1 each (10 requests)       |

Notes on the rows:

- **A retry is a new execution.** It has a new id, `mode: retry` and `retryOf` set to the failed one. Anything built from `$execution.id` changes on a retry, so it cannot be an idempotency key.
- **The node before the failed one did not run again** in any case. The stand-in counted that step once.
- **Items after the failed one.** The HTTP Request node sends the items of one run side by side and looks at errors afterwards. When item 3 failed, 4 and 5 were already out. So "fails on item 3" does not mean "stopped at item 3".
- **Nothing stops a second retry.** An execution that was already retried with success can be retried again, from the editor or the API, and sends again. With an `Idempotency-Key` header on `POST /executions/{id}/retry`, three identical requests started one retry and returned the same execution id; the same key with a different body got `422`.
- **`loadWorkflow`.** The test edited the calling node, then retried. `false` (editor: "Retry with original workflow") ran the node as it was when the execution failed. `true` (editor: "Retry with currently saved workflow") ran the edited node. Both started at the failed node and sent all five items.
- **Loop Over Items with batch size 1** is the one built-in shape where items 1 and 2 are not repeated. The item that failed is still sent again.
- **Check in front of the call.** The check and the claim ran in the first execution. The retry started at the call with the same five items and never asked the ledger.

With **Guarded call** (the stand-in does not honour the key here, so the ledger alone has to hold):

| Case                                                                 | First run | Retry          | Times each item was done |
| -------------------------------------------------------------------- | --------- | -------------- | ------------------------ |
| `lookup`: item 3 done by the service, answered 500                   | 1 2 3     | 4 5            | 1 each                   |
| `lookup`: item 3 refused with 503, nothing done                      | 1 2 3     | 3 4 5          | 1 each                   |
| `lookup`: one call, done by the service, answered after the timeout  | 1         | nothing        | 1                        |
| `hold`: item 3 done by the service, answered 500; retried 3 times    | 1 2 3     | 4 5            | 1 each, retries end red  |
| `hold`: item 3 refused; retried                                      | 1 2 3     | 4 5            | 1 each, item 3 held      |
| then: the row of item 3 deleted by hand, first execution retried     |           | 3              | 1 each, retry ends green |
| `lookup`: the same execution retried 4 times, API and editor         | 1 2 3     | 4 5            | 1 each                   |
| `lookup`: Retry On Fail on the Execute Sub-workflow node             | 1 2 3     | 4 5 (same run) | 1 each, run ends green   |
| `lookup`: two retries of one execution at the same instant, 10 times | 1 2 3     | 3 4 5, once    | 1 each, every round      |
| `lookup`: a second run arrives while the first waits for the service | 1         | nothing        | 1, second run is `busy`  |
| Two runs with the same 5 keys at the same instant, 10 times          | 1 2 3 4 5 |                | 1 each, every round      |

## Guarded call

`workflows/1-guarded-call.json` is a sub-workflow. It takes one item with a `key` and makes the call at most once for that key.

Why a sub-workflow: a retry starts at the failed node, and nothing in front of it runs again. A failed **Execute Sub-workflow** node is the exception, it runs the whole sub-workflow again. So the check has to live inside the thing that gets retried.

It keeps one row per key in the data table `retry_ledger`:

- `sending`: written before the call. A run that meets this row while it is young answers `busy` and does not call.
- `done`: the service answered. Later runs answer `already_done` and do not call.
- `unknown`: the call failed or timed out. Nobody knows whether the service did the work. The run then fails, so the execution can be retried.

What a retry does with an `unknown` row is your choice (`ON_UNKNOWN` at the top of the **Entry** node):

- `hold` (default): no call. The item comes back with `outcome: held`. A person checks the service, then sets the row to `done`, or deletes it to send again.
- `lookup`: ask the service whether it has this key. Found: mark `done`, no call. A clear "not there": call again. Anything else: `held`.

Use `lookup` only if the service shows a write the moment it happens. A lookup that lags says "not there" about something that is there, and you send twice.

Other details:

- The key must be the same on every attempt and come from your data: order id plus line, event id plus recipient. Not `$execution.id`.
- New rows and resends are claimed with "insert a row, then read the lowest row id for the key". Two runs that start together cannot both win. Data Tables have no unique constraint, so this is the pattern that holds.
- The key is also sent as `Idempotency-Key`. If your service honours it, you have a second layer.
- Outcomes: `sent`, `already_done`, `found_at_service`, `held`, `busy`.

## Add it to your n8n

Works with Data Tables only, so no extra database. Not tested on n8n Cloud.

1. Import `workflows/0-setup.json` and `workflows/1-guarded-call.json` (Workflows > Import from File).
2. Open **Retry Effects · 0 Setup** and press **Execute workflow** once. It creates the data table `retry_ledger`.
3. In **Retry Effects · 1 Guarded call**:
   - Replace **Call the service** with your own node. Keep its **On Error** setting on _Continue (using error output)_ and keep the error output wired to **Mark unknown**. Your item's data is at `$('Entry').first().json.payload`.
   - Either replace **Look it up** with a request that asks your service for the key, and adapt **Found there?** and **Clearly not there?** to its answer, or leave `ON_UNKNOWN` on `hold`.
   - Set `LEASE_SECONDS` in **Entry** longer than your slowest call.
   - Publish it.
4. In your workflow, where the call was: an **Execute Sub-workflow** node on Guarded call, mode **Run once for each item**. Each item needs `key` and `payload`.
5. After it, send items with `outcome` `held` or `busy` somewhere a person sees them. The lab ends the run with a **Stop and Error** node, so it shows red.

Two things to know when you use it:

- After you release a held item, retry the execution that failed at the Execute Sub-workflow node. A run that ended at your "held" alarm node restarts at that alarm node and does not go back into the guard.
- It runs one sub-workflow execution per item. That is slower than one HTTP Request node with all items.

## Run the measurements yourself

```sh
git clone https://github.com/feversoul/n8n-retry-effects
cd n8n-retry-effects
npm run test:e2e          # regular mode, SQLite
npm run test:e2e:queue    # queue mode: main + one worker, Redis, PostgreSQL
```

Needs Docker and Node 20 or newer. The tests create the owner account and an API key through n8n's own endpoints (`POST /rest/owner/setup`, `POST /rest/api-keys`), then use `POST /api/v1/executions/{id}/retry` and the editor's `POST /rest/executions/{id}/retry`. `KEEP_STACK=1` leaves the stack up so you can open the executions in the editor.

To look around by hand: `cp .env.example .env`, fill it in, `docker compose up -d`. The lab workflow and its webhooks have no authentication. Keep them on a local stack.

After changing `scripts/build.mjs`, run `npm run build` to write `workflows/*.json` again.

## What was tested

`npm run test:e2e` and `npm run test:e2e:queue`, each from a fresh stack, n8n 2.47.7:

| Run                                       | Result          |
| ----------------------------------------- | --------------- |
| Regular mode, n8n on SQLite               | 23 of 23 passed |
| Queue mode, main + one worker, PostgreSQL | 23 of 23 passed |

Every row of the two tables above is one of these tests, with the counts asserted.

## What was not tested, and other limits

- The service is a stand-in. No real payment, mail or CRM provider was called. How a real provider treats `Idempotency-Key` or a lookup is for you to check.
- n8n Cloud. Versions other than 2.47.7. Queue mode with more than one worker.
- An n8n process that dies in the middle of a call. The guard treats a `sending` row older than `LEASE_SECONDS` as `unknown`; that path, and retrying a crashed execution, were not run.
- An Error Workflow that triggers the retry by itself. The lab retries by API and by the editor's endpoint only.
- A workflow that is saved but not yet published. The test edited the workflow through the public API, which published the edit at once.
- Nodes other than HTTP Request. "All items were already sent when item 3 failed" is how that node behaved here; a node that works through its items one after the other may stop at the failed one.
- The `Idempotency-Key` header of the retry endpoint was tried with three requests one after the other, not at the same instant.
- `hold` needs a person. `lookup` is only as good as the service's lookup.
- The ledger grows by one row per key. Nothing deletes old rows.

## License

MIT
