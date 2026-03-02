const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

// Load environment variables
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ================== Middleware ==================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'secret-key-change-in-production',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // set to true if using HTTPS
}));

// Authentication middleware
const requireAuth = (req, res, next) => {
  if (req.session.authenticated) {
    next();
  } else {
    res.redirect('/login');
  }
};

// ================== Google Sheets Setup ==================
let sheets;
let spreadsheetId;

async function initGoogleSheets() {
  try {
    const base64Key = process.env.GOOGLE_SERVICE_ACCOUNT_BASE64;
    if (!base64Key) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_BASE64 env var');
    
    const credentials = JSON.parse(Buffer.from(base64Key, 'base64').toString('utf8'));
    
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    
    const client = await auth.getClient();
    sheets = google.sheets({ version: 'v4', auth: client });
    spreadsheetId = process.env.SPREADSHEET_ID;
    if (!spreadsheetId) throw new Error('Missing SPREADSHEET_ID env var');
    
    console.log('Google Sheets initialized');
  } catch (error) {
    console.error('Failed to initialize Google Sheets:', error);
    process.exit(1);
  }
}

// ================== WhatsApp Client Setup ==================
let whatsappClient;
let whatsappReady = false;
let qrCodeData = null;

async function initWhatsApp() {
  try {
    // Use session from env if available
    const sessionData = process.env.WHATSAPP_SESSION_BASE64;
    let sessionPath = path.join(__dirname, '.wwebjs_auth');
    
    // If session data exists, write to file (whatsapp-web.js will read from there)
    if (sessionData) {
      const sessionDir = path.join(sessionPath, 'session');
      if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
      }
      // Note: whatsapp-web.js stores session in a JSON file, we'll just pass the base64 as env
      // Alternatively, we can use the built-in LocalAuth which stores in .wwebjs_auth
      // So we don't need to manually inject base64; we can rely on file persistence.
      // Since Render doesn't persist files, we need to backup and restore session.
      // Let's implement a custom strategy: after successful auth, save session as base64 env.
    }

    whatsappClient = new Client({
      authStrategy: new LocalAuth({ dataPath: sessionPath }),
      puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
    });

    whatsappClient.on('qr', (qr) => {
      console.log('QR RECEIVED', qr);
      qrCodeData = qr;
      qrcode.generate(qr, { small: true });
    });

    whatsappClient.on('ready', () => {
      console.log('WhatsApp client is ready!');
      whatsappReady = true;
      qrCodeData = null;
      
      // After ready, we can backup session to env variable for next run
      // This requires reading the session files and converting to base64
      // We'll implement a function for that
      backupSessionToEnv();
    });

    whatsappClient.on('disconnected', (reason) => {
      console.log('WhatsApp disconnected:', reason);
      whatsappReady = false;
    });

    whatsappClient.on('auth_failure', (msg) => {
      console.error('Authentication failure:', msg);
      whatsappReady = false;
    });

    await whatsappClient.initialize();
  } catch (error) {
    console.error('Failed to initialize WhatsApp client:', error);
  }
}

// Function to backup session data to environment variable
function backupSessionToEnv() {
  const sessionPath = path.join(__dirname, '.wwebjs_auth', 'session');
  if (fs.existsSync(sessionPath)) {
    // Read all files in session directory and create a JSON object
    const files = fs.readdirSync(sessionPath);
    const sessionData = {};
    files.forEach(file => {
      const filePath = path.join(sessionPath, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      sessionData[file] = content;
    });
    const base64 = Buffer.from(JSON.stringify(sessionData)).toString('base64');
    // Log it so user can copy and set as environment variable
    console.log('==================================================');
    console.log('WHATSAPP_SESSION_BASE64 (save this as env variable):');
    console.log(base64);
    console.log('==================================================');
  }
}

// ================== Helper Functions ==================
async function getPhoneNumbersFromSheet() {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'A:A', // Column A
    });
    const rows = response.data.values || [];
    // Assuming first row is header? If yes, skip it. Let's skip if first cell is text.
    const startIndex = rows.length > 0 && rows[0][0] && rows[0][0].toLowerCase().includes('phone') ? 1 : 0;
    return rows.slice(startIndex).map(row => row[0]).filter(Boolean);
  } catch (error) {
    console.error('Error reading sheet:', error);
    return [];
  }
}

async function updateSheetStatus(index, status) {
  try {
    // Update column C at row index+2 (since A1 is header, A2 is first number)
    const rowNumber = index + 2; // adjust if header exists
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `C${rowNumber}`,
      valueInputOption: 'RAW',
      resource: { values: [[status]] }
    });
  } catch (error) {
    console.error('Error updating sheet:', error);
  }
}

async function logSessionToSheet(phone, status) {
  try {
    // Append to Logs sheet (assumes there is a sheet named "Logs" with columns: Timestamp, Phone, Status)
    const timestamp = new Date().toISOString();
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'Logs!A:C',
      valueInputOption: 'RAW',
      resource: { values: [[timestamp, phone, status]] }
    });
  } catch (error) {
    console.error('Error logging to sheet:', error);
  }
}

async function getStats() {
  try {
    // Get current session stats (from Logs sheet)
    const logsResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Logs!A:C',
    });
    const logs = logsResponse.data.values || [];
    
    // Get all previous sessions stats (from same Logs sheet, we can group by date or just count all)
    // For simplicity, we'll return:
    // - lastSessionCount: number of logs in the most recent distinct date (if timestamp column exists)
    // - totalSent: total successful sends
    // - totalFailed: total failed attempts
    // - totalNumbers: total phone numbers in column A
    const phoneNumbers = await getPhoneNumbersFromSheet();
    const totalNumbers = phoneNumbers.length;
    
    let totalSent = 0, totalFailed = 0;
    logs.forEach(row => {
      if (row[2] === 'sent') totalSent++;
      else if (row[2] === 'failed') totalFailed++;
    });
    
    // Last session: group logs by date (first 10 chars of timestamp)
    const sessions = {};
    logs.forEach(row => {
      if (row[0]) {
        const date = row[0].substring(0, 10); // YYYY-MM-DD
        if (!sessions[date]) sessions[date] = { sent: 0, failed: 0 };
        if (row[2] === 'sent') sessions[date].sent++;
        else if (row[2] === 'failed') sessions[date].failed++;
      }
    });
    
    const lastSessionDate = Object.keys(sessions).sort().pop() || 'N/A';
    const lastSession = sessions[lastSessionDate] || { sent: 0, failed: 0 };
    
    return {
      lastSession: { date: lastSessionDate, ...lastSession },
      total: { sent: totalSent, failed: totalFailed, totalNumbers }
    };
  } catch (error) {
    console.error('Error getting stats:', error);
    return { lastSession: { sent: 0, failed: 0, date: 'N/A' }, total: { sent: 0, failed: 0, totalNumbers: 0 } };
  }
}

// ================== API Routes ==================
app.get('/login', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Login</title>
      <style>
        body { font-family: Arial, sans-serif; background: #f4f4f4; display: flex; justify-content: center; align-items: center; height: 100vh; }
        .login-box { background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        input { padding: 10px; width: 250px; margin: 10px 0; border: 1px solid #ddd; border-radius: 4px; }
        button { padding: 10px 20px; background: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer; }
        button:hover { background: #218838; }
      </style>
    </head>
    <body>
      <div class="login-box">
        <h2>Dashboard Login</h2>
        <form method="POST" action="/login">
          <input type="password" name="password" placeholder="Enter password" required />
          <button type="submit">Login</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

app.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.DASHBOARD_PASSWORD) {
    req.session.authenticated = true;
    res.redirect('/dashboard');
  } else {
    res.send('Invalid password. <a href="/login">Try again</a>');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

app.get('/dashboard', requireAuth, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Dashboard - WhatsApp Sender</title>
      <style>
        body { font-family: Arial, sans-serif; background: #f4f4f4; margin: 0; padding: 20px; }
        .container { max-width: 1000px; margin: auto; background: white; padding: 20px; border-radius: 8px; }
        h1, h2 { color: #333; }
        .stats { display: flex; gap: 20px; margin: 20px 0; }
        .stat-box { background: #007bff; color: white; padding: 20px; border-radius: 8px; flex: 1; text-align: center; }
        .stat-box.failed { background: #dc3545; }
        .stat-box.success { background: #28a745; }
        .stat-box.total { background: #6c757d; }
        .number { font-size: 2em; font-weight: bold; }
        button { padding: 10px 20px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 16px; margin: 5px; }
        button:hover { background: #0056b3; }
        button.danger { background: #dc3545; }
        button.danger:hover { background: #c82333; }
        .qr-code { margin-top: 20px; padding: 20px; background: #f8f9fa; border: 1px dashed #007bff; border-radius: 8px; text-align: center; }
        pre { background: #f4f4f4; padding: 10px; border-radius: 4px; overflow-x: auto; }
        .status { margin-top: 20px; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>WhatsApp Message Sender Dashboard</h1>
        <p><a href="/logout">Logout</a></p>
        
        <div id="qr-container" style="display: none;" class="qr-code">
          <h3>Scan QR Code with WhatsApp</h3>
          <div id="qr"></div>
          <p>After scanning, the client will be ready.</p>
        </div>

        <div id="stats">
          <h2>Statistics</h2>
          <div class="stats">
            <div class="stat-box">
              <div>Last Session Sent</div>
              <div class="number" id="lastSent">0</div>
            </div>
            <div class="stat-box failed">
              <div>Last Session Failed</div>
              <div class="number" id="lastFailed">0</div>
            </div>
            <div class="stat-box success">
              <div>Total Sent</div>
              <div class="number" id="totalSent">0</div>
            </div>
            <div class="stat-box failed">
              <div>Total Failed</div>
              <div class="number" id="totalFailed">0</div>
            </div>
            <div class="stat-box total">
              <div>Total Numbers in Sheet</div>
              <div class="number" id="totalNumbers">0</div>
            </div>
          </div>
        </div>

        <div class="actions">
          <button onclick="sendMessages()">Send Messages</button>
          <button onclick="refreshStats()">Refresh Stats</button>
          <button onclick="checkStatus()">Check WhatsApp Status</button>
        </div>

        <div id="message" class="status"></div>
      </div>

      <script>
        async function refreshStats() {
          const res = await fetch('/api/stats');
          const data = await res.json();
          document.getElementById('lastSent').innerText = data.lastSession.sent;
          document.getElementById('lastFailed').innerText = data.lastSession.failed;
          document.getElementById('totalSent').innerText = data.total.sent;
          document.getElementById('totalFailed').innerText = data.total.failed;
          document.getElementById('totalNumbers').innerText = data.total.totalNumbers;
        }

        async function sendMessages() {
          document.getElementById('message').innerHTML = 'Sending messages...';
          const res = await fetch('/api/send', { method: 'POST' });
          const data = await res.json();
          if (data.error === 'WHATSAPP_NOT_READY') {
            document.getElementById('message').innerHTML = 'WhatsApp not ready. Please scan QR code below.';
            fetchQR();
          } else {
            document.getElementById('message').innerHTML = JSON.stringify(data);
            refreshStats();
          }
        }

        async function fetchQR() {
          const res = await fetch('/api/qr');
          const data = await res.json();
          if (data.qr) {
            document.getElementById('qr-container').style.display = 'block';
            document.getElementById('qr').innerHTML = \`<pre>\${data.qr}</pre>\`;
          } else if (data.ready) {
            document.getElementById('qr-container').style.display = 'none';
            document.getElementById('message').innerHTML = 'WhatsApp is ready!';
          }
        }

        async function checkStatus() {
          const res = await fetch('/api/status');
          const data = await res.json();
          document.getElementById('message').innerHTML = \`WhatsApp Ready: \${data.ready}\`;
          if (!data.ready && data.qr) {
            document.getElementById('qr-container').style.display = 'block';
            document.getElementById('qr').innerHTML = \`<pre>\${data.qr}</pre>\`;
          }
        }

        // Initial load
        refreshStats();
      </script>
    </body>
    </html>
  `);
});

app.get('/api/stats', requireAuth, async (req, res) => {
  const stats = await getStats();
  res.json(stats);
});

app.get('/api/status', requireAuth, (req, res) => {
  res.json({ ready: whatsappReady, qr: qrCodeData });
});

app.get('/api/qr', requireAuth, (req, res) => {
  res.json({ qr: qrCodeData, ready: whatsappReady });
});

app.post('/api/send', requireAuth, async (req, res) => {
  if (!whatsappReady) {
    return res.status(400).json({ error: 'WHATSAPP_NOT_READY', qr: qrCodeData });
  }

  try {
    const phoneNumbers = await getPhoneNumbersFromSheet();
    const messageTemplate = `السيد / العميل الكريم

إنذار قانوني نهائي

بمراجعة سجلات الحساب لدى شركة بتروتريد تبين وجود مديونية مستحقة عليكم مقابل استهلاك الغاز الطبيعي، ولم يتم سدادها حتى تاريخه رغم التنبيهات والمطالبات السابقة.

وعليه يعتبر هذا الإخطار **إنذارًا قانونيًا نهائيًا وأخيرًا** بضرورة سداد كامل المديونية خلال مدة أقصاها **48 ساعة من تاريخ استلام هذه الرسالة**.

وفي حالة عدم السداد خلال المهلة المحددة، ستقوم الشركة فورًا ودون أي إخطار آخر باتخاذ كافة الإجراءات القانونية المقررة قانونًا، والتي تشمل على سبيل المثال لا الحصر:

• تحرير محضر ورفع **جنحة تبديد مواد بترولية** ضد سيادتكم.
• استبدال العداد الحالي بعداد **مسبق الدفع (كارت)** طبقًا للوائح المنظمة.
• تحميل العميل **كامل تكلفة العداد الجديد ومصاريف التركيب والإجراءات**، على أن يتم خصمها من عمليات شحن العداد.
• اتخاذ الإجراءات القضائية اللازمة لتحصيل المديونية مع **إلزامكم بالمصاريف القضائية وأتعاب المحاماة**.

لذا نهيب بسيادتكم سرعة التوجه إلى مقر الشركة أو التواصل فورًا لتسوية المديونية تفاديًا لاتخاذ الإجراءات القانونية.

العنوان: ش. شكري القواتلي – مول أبو هارون – الدور الثالث علوي
شركة بتروتريد
إدارة التحصيل`;

    const results = [];
    
    for (let i = 0; i < phoneNumbers.length; i++) {
      const phone = phoneNumbers[i];
      try {
        // Format phone number: remove any non-digit, ensure it has country code
        let formattedPhone = phone.replace(/\D/g, '');
        if (!formattedPhone.startsWith('20')) { // Egypt country code
          formattedPhone = '20' + formattedPhone.replace(/^0+/, '');
        }
        formattedPhone = formattedPhone + '@c.us'; // WhatsApp suffix
        
        const chat = await whatsappClient.getChatById(formattedPhone);
        await chat.sendMessage(messageTemplate);
        
        await updateSheetStatus(i, 'sent');
        await logSessionToSheet(phone, 'sent');
        results.push({ phone, status: 'sent' });
      } catch (err) {
        console.error(`Failed to send to ${phone}:`, err);
        await updateSheetStatus(i, 'failed');
        await logSessionToSheet(phone, 'failed');
        results.push({ phone, status: 'failed', error: err.message });
      }
      // Delay to avoid being blocked
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    
    res.json({ success: true, results });
  } catch (error) {
    console.error('Error in send endpoint:', error);
    res.status(500).json({ error: error.message });
  }
});

// ================== Start Server ==================
(async () => {
  await initGoogleSheets();
  await initWhatsApp();
  
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
})();