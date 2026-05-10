/**
 * Pluks download-form leads → Google Sheet ingestion endpoint.
 *
 * Deployed as a Google Apps Script web app. Receives POSTs from
 * website/demo.js when a visitor submits the download modal, and appends
 * a row to the active spreadsheet's "Leads" sheet (or the active sheet
 * if no sheet is named "Leads" yet).
 *
 * Setup:
 *  1. Create a Google Sheet. First row headers (recommended order):
 *       timestamp | email | persona | platform | referrer_host | user_agent
 *     Copy its ID from the URL (the long token between /d/ and /edit) and
 *     paste it into LEADS_SHEET_ID below.
 *  2. script.google.com → New project. Paste this file. Save.
 *     (Standalone project is fine — we open the sheet by ID rather than
 *     relying on a bound spreadsheet, so getActiveSpreadsheet() is not used.)
 *  3. From the editor, run `smokeTest` once. Accept the OAuth prompt to
 *     grant the Spreadsheet scope to the deployer identity. A row labelled
 *     "test@example.com / engineer" should appear in the sheet.
 *  4. Deploy → New deployment → Type: Web app.
 *     - Execute as: Me
 *     - Who has access: Anyone (required for the website to POST anonymously)
 *  5. Copy the Web app URL. Paste it into website/demo.js as `LEADS_ENDPOINT`.
 *  6. Test by submitting the download form on the deployed site;
 *     a row should appear in the sheet within a few seconds. When pushing
 *     edits, use Manage deployments → edit → New version (keeps the URL
 *     stable). Creating a brand-new deployment rotates the URL and you'll
 *     have to re-paste it into demo.js.
 *
 * Privacy note:
 *  - Apps Script web apps deployed "Anyone" accept anonymous POSTs from the
 *    open web. The validators below drop malformed payloads but won't stop
 *    a determined spammer who reads the JS source and replays. If volume
 *    becomes an issue, add hCaptcha to the form or rotate the deployment URL.
 *
 * Payload shape (text/plain JSON, sent via sendBeacon):
 *   { email, persona, platform?, referrer_host?, user_agent? }
 */

const LEADS_SHEET_ID = '1a08WC0DwzedpCggV3zV4cX9UbL6T0Y-tjG2QXc-Z-h4';

const VALID_PERSONAS = [
  'engineer', 'designer', 'pm', 'researcher',
  'writer', 'marketing', 'support', 'student', 'other'
];

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return _ok('empty');
    }
    const data = JSON.parse(e.postData.contents);

    if (!data.email || !EMAIL_RX.test(data.email)) return _ok('bad_email');
    if (data.email.length > 256) return _ok('email_too_long');
    if (!VALID_PERSONAS.includes(data.persona)) return _ok('bad_persona');

    const ss = SpreadsheetApp.openById(LEADS_SHEET_ID);
    const sheet = ss.getSheetByName('Leads') || ss.getActiveSheet();

    sheet.appendRow([
      new Date(),
      String(data.email).slice(0, 256),
      String(data.persona),
      String(data.platform || '').slice(0, 64),
      String(data.referrer_host || '').slice(0, 128),
      String(data.user_agent || '').slice(0, 512)
    ]);

    return _ok('ok');
  } catch (err) {
    // Don't surface the parse error — keep the response opaque.
    console.error('doPost error', err);
    return _ok('error');
  }
}

function _ok(body) {
  return ContentService.createTextOutput(body)
    .setMimeType(ContentService.MimeType.TEXT);
}

// Smoke test: from the Apps Script editor pick this function and click Run.
// A row labelled "test@example.com / engineer" should appear in the sheet.
function smokeTest() {
  doPost({
    postData: {
      contents: JSON.stringify({
        email: 'test@example.com',
        persona: 'engineer',
        platform: 'mac',
        referrer_host: 'pluks.app',
        user_agent: 'apps-script-smoketest'
      })
    }
  });
}
