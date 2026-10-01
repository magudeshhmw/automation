# Event Mailer

Sends personalised emails to everyone who filled in your Google Form: invitations before an event, and thank-you emails with their own certificate after it.
It runs entirely on your computer. It's free, and needs no AI and no API keys. Ollama is optional and only drafts text.

## Start
Double-click **start.bat**. It opens at http://127.0.0.1:8765. Keep the black window open while you use it.

## Steps
1. **Account**: connect your Gmail with a 16-letter App Password (myaccount.google.com/apppasswords). You only do this once.
2. **Participants**: drop in the Google Form export (.xlsx or .csv). The Name and Email columns are detected automatically.
3. **Message**: choose a template:
   - **📨 Invitation**: sent before the event, with the meeting link, date and time
   - **🎓 Thank you + Certificate**: sent after the event, with each person's certificate attached
   - **＋ New template**: anything else, such as a reminder or a feedback request

   Fill in the **Event details** (link, date, time…) and type **@** to insert any field.
   Use the toolbar for bold, colours and lists. Click an @field and press **B** to bold it.
   Add any documents (PDF, slides…) and they go to everyone.
4. **Certificate** (only when switched on): upload your blank certificate. Use **＋ Add** to place the name, date and signature, and style them with the Word-like toolbar.
5. **Review & Send**: check the final preview, send yourself a test, tick or untick people, then send.

## Limits
A normal Gmail account sends about **500 emails a day**. Attachments can total up to about **25 MB per email**.

## Files (all in `data/`)
- `template.json`: templates, event details, certificate design, last sheet
- `config.json`: Gmail login (kept only on this computer)
- `attachments/`: uploaded documents
- `send_log.csv`: every email sent, used to skip people who already got a template today
