# KTU Excuse Court

## Run it locally

1. In this folder, run `npm install` once.
2. Run `npm start`.
3. Open `http://127.0.0.1:3000` (use this exact address, not `localhost`).

This live edition has a shared, role-based trial room. For the local hackathon demo, the access codes are:

| Role | Local code |
|---|---|
| Admin | `ADMIN-COURT` |
| Judge | `JUDGE-COURT` |
| Jury | `JURY-COURT` |
| Student | `STUDENT-COURT` |

Students file fictional cases. Judges reveal exhibits, call witnesses, and issue a verdict. Jury members use the room code shown to the judge and cast one server-enforced vote. Admins have judge-level control.

For a live demonstration, open separate tabs and sign in with a different role in each. Roles are stored separately per tab, so a Judge tab will not replace a Jury or Student tab.

## Live audience tribunal

1. Have a Student file a case, then sign in as Judge or Admin and select it.
2. Select **BROADCAST THIS CASE**. The host panel displays a room code, join URL, and QR code.
3. Project that QR code. Audience members scan it, choose an optional fictional nickname, and join without an account.
4. The host reveals exhibits and witnesses, then selects **OPEN THE BALLOT BOX**.
5. Audience members can vote or change their vote while the ballot box is open. The host closes voting, optionally convenes Hon. Byte Bias, and drops the verdict.

Live rooms are deliberately in server memory for the hackathon MVP. A server restart or Render redeploy ends active rooms and clears their audience list. PostgreSQL preserves normal cases, users, and logs only when `DATABASE_URL` is configured.

## Deploy on Render

Push this folder to a GitHub repository, then create a Render Blueprint from that repository. The included `render.yaml` creates the Node web service and PostgreSQL database. In Render, supply private values for `ADMIN_CODE`, `JUDGE_CODE`, `JURY_CODE`, and `STUDENT_CODE`; never use the local demo codes publicly.

The app uses PostgreSQL automatically when `DATABASE_URL` is present. Without it, it runs with temporary in-memory data for local smoke testing only.

## Optional live AI material

The app has a safe fallback by default. To generate custom fictional evidence, witnesses, opening statements, questions, and sentences from each case, set an OpenAI API key in the terminal before starting the server:

```powershell
$env:OPENAI_API_KEY="your-key-here"
$env:OPENAI_MODEL="gpt-4o-mini"
npm start
```

Never put this key in `live.js`, `app.js`, or a public GitHub repository. For Render, set `OPENAI_API_KEY` in the service's private environment variables. The case header will report `LIVE AI` when the key is active and `DEMO FALLBACK` otherwise.
