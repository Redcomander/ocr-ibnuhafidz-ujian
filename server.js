const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const sharp = require('sharp');
const { execFile } = require('child_process');
const { promisify } = require('util');
const {
  DEFAULT_CALIBRATION,
  loadAnswerKey,
  sanitizeCalibration,
  sanitizeRotation,
  scanBuffer,
  generateAnswerKeyTemplate,
  parseAnswerKeyFromText,
  validateAnswerKey,
} = require('./lib/ocr-core');

const execFileAsync = promisify(execFile);

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 30,
  },
});

function readConnectorConfig() {
  const configPath = path.resolve(__dirname, 'connector.config.json');
  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const connectorConfig = readConnectorConfig();
const PORT = Number(process.env.PORT || connectorConfig.port || 3099);
const HOST = String(process.env.HOST || connectorConfig.host || '127.0.0.1').trim();
const CONNECTOR_TOKEN = String(process.env.SCANNER_CONNECTOR_TOKEN || connectorConfig.token || '').trim();
const ALLOWED_ORIGINS_RAW = process.env.SCANNER_ALLOWED_ORIGINS
  || (Array.isArray(connectorConfig.allowedOrigins) ? connectorConfig.allowedOrigins.join(',') : String(connectorConfig.allowedOrigins || ''));
const ALLOWED_ORIGINS = String(ALLOWED_ORIGINS_RAW || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const defaultKeyPath = path.resolve(__dirname, 'answer_key.json');
const PUBLIC_API_PATHS = new Set(['/api/health']);

function parseConnectorToken(req) {
  const xToken = String(req.get('X-Scanner-Token') || '').trim();
  if (xToken) {
    return xToken;
  }

  const authHeader = String(req.get('Authorization') || '').trim();
  const parts = authHeader.split(' ');
  if (parts.length === 2 && /^bearer$/i.test(parts[0])) {
    return String(parts[1] || '').trim();
  }

  return '';
}

function connectorAuth(req, res, next) {
  if (!req.path.startsWith('/api/') || PUBLIC_API_PATHS.has(req.path)) {
    return next();
  }

  if (!CONNECTOR_TOKEN) {
    return next();
  }

  const incomingToken = parseConnectorToken(req);
  if (!incomingToken || incomingToken !== CONNECTOR_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized connector request.' });
  }

  return next();
}

function getKeyMap() {
  if (!fs.existsSync(defaultKeyPath)) {
    return null;
  }
  return loadAnswerKey(defaultKeyPath);
}

function getCapabilities() {
  const hardwareScannerSupported = process.platform === 'win32';
  return {
    hardwareScanner: {
      supported: hardwareScannerSupported,
      reason: hardwareScannerSupported ? null : 'Hardware scanner endpoint is available only on Windows host with WIA scanner support.',
    },
  };
}

async function runPowerShellScript(script, timeout = 120000) {
  const scriptPath = path.join(os.tmpdir(), `ocr_reader_${Date.now()}_${Math.random().toString(16).slice(2)}.ps1`);

  try {
    fs.writeFileSync(scriptPath, `${script}\n`, 'utf8');

    return await execFileAsync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      timeout,
      windowsHide: false,
    });
  } catch (error) {
    const stderr = String(error?.stderr || '').trim();
    const stdout = String(error?.stdout || '').trim();
    const base = String(error?.message || 'PowerShell execution failed').trim();
    const detail = stderr || stdout;
    throw new Error(detail ? `${base}\n${detail}` : base);
  } finally {
    if (fs.existsSync(scriptPath)) {
      fs.unlinkSync(scriptPath);
    }
  }
}

function escapePsSingleQuoted(value) {
  return String(value || '').replace(/'/g, "''");
}

function getBufferSignature(buffer, bytes = 12) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return 'empty';
  }

  return buffer.subarray(0, Math.min(bytes, buffer.length)).toString('hex');
}

async function normalizeScannedImageBuffer(inputBuffer) {
  if (!Buffer.isBuffer(inputBuffer) || inputBuffer.length === 0) {
    throw new Error('Scanner returned an empty image file.');
  }

  try {
    return await sharp(inputBuffer).rotate().png().toBuffer();
  } catch (error) {
    const signature = getBufferSignature(inputBuffer);
    const detail = error?.message ? ` ${error.message}` : '';
    throw new Error(`Scanner returned an unreadable image format. Signature: ${signature}.${detail}`);
  }
}

async function normalizeScannedImageFileOnWindows(inputPath) {
  if (process.platform !== 'win32') {
    throw new Error('Windows scanner file normalization is unavailable on this platform.');
  }

  const outputPath = path.join(os.tmpdir(), `ocr_scanner_normalized_${Date.now()}.png`);
  const escapedInputPath = escapePsSingleQuoted(inputPath);
  const escapedOutputPath = escapePsSingleQuoted(outputPath);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Drawing',
    `$inputPath = '${escapedInputPath}'`,
    `$outputPath = '${escapedOutputPath}'`,
    '$image = [System.Drawing.Image]::FromFile($inputPath)',
    'try {',
    '  $bitmap = New-Object System.Drawing.Bitmap $image',
    '  try {',
    '    $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)',
    '  } finally {',
    '    $bitmap.Dispose()',
    '  }',
    '} finally {',
    '  $image.Dispose()',
    '}',
    'Write-Output $outputPath',
  ].join('\n');

  try {
    const { stdout } = await runPowerShellScript(script, 60000);
    const normalizedPath = String(stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .pop();

    if (!normalizedPath || !fs.existsSync(normalizedPath)) {
      throw new Error('Windows image normalization did not produce an output file.');
    }

    return {
      buffer: fs.readFileSync(normalizedPath),
      outputPath: normalizedPath,
    };
  } catch (error) {
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }
    throw error;
  }
}

async function listWindowsScanners() {
  if (process.platform !== 'win32') {
    return [];
  }

  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$dm = New-Object -ComObject WIA.DeviceManager',
    '$devices = @()',
    'foreach ($info in $dm.DeviceInfos) {',
    '  if ($info.Type -eq 1) {',
    '    $name = "Unknown scanner"',
    '    $manufacturer = ""',
    '    try { $name = [string]$info.Properties.Item("Name").Value } catch {}',
    '    try { $manufacturer = [string]$info.Properties.Item("Manufacturer").Value } catch {}',
    '    $devices += [PSCustomObject]@{ deviceId = [string]$info.DeviceID; name = $name; manufacturer = $manufacturer }',
    '  }',
    '}',
    '$devices | ConvertTo-Json -Compress -Depth 4',
  ].join('\n');

  const { stdout } = await runPowerShellScript(script, 30000);
  const payload = String(stdout || '').trim();
  if (!payload) {
    return [];
  }

  const parsed = JSON.parse(payload);
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed && typeof parsed === 'object') {
    return [parsed];
  }
  return [];
}

async function acquireFromWindowsScanner(scannerDeviceId) {
  if (process.platform !== 'win32') {
    throw new Error('Hardware scanner endpoint currently supports Windows only.');
  }

  const tempDir = os.tmpdir();
  const baseName = `ocr_scanner_${Date.now()}`;
  const escapedTempDir = escapePsSingleQuoted(tempDir);
  const escapedBaseName = escapePsSingleQuoted(baseName);
  const escapedDeviceId = escapePsSingleQuoted(scannerDeviceId || '');

  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$tempDir = '${escapedTempDir}'`,
    `$baseName = '${escapedBaseName}'`,
    `$scannerDeviceId = '${escapedDeviceId}'`,
    'function Test-IsBusyError([string]$message) {',
    '  if ([string]::IsNullOrWhiteSpace($message)) { return $false }',
    '  return $message.ToLowerInvariant().Contains("device is busy")',
    '}',
    'function Connect-ScannerDevice($deviceInfo) {',
    '  $lastError = $null',
    '  for ($attempt = 1; $attempt -le 4; $attempt++) {',
    '    try {',
    '      return $deviceInfo.Connect()',
    '    } catch {',
    '      $lastError = $_.Exception.Message',
    '      if (-not (Test-IsBusyError $lastError) -or $attempt -eq 4) { throw }',
    '      Start-Sleep -Milliseconds (600 * $attempt)',
    '    }',
    '  }',
    '  throw $lastError',
    '}',
    'function Convert-ScannerImage($image, $formatGuid, $quality = $null) {',
    '  $imageProcessor = New-Object -ComObject WIA.ImageProcess',
    '  $convertFilter = $imageProcessor.FilterInfos | Where-Object { $_.Name -eq "Convert" } | Select-Object -First 1',
    '  if ($null -eq $convertFilter) { throw "WIA Convert filter is not available." }',
    '  $imageProcessor.Filters.Add($convertFilter.FilterID)',
    '  $imageProcessor.Filters.Item(1).Properties.Item("FormatID").Value = $formatGuid',
    '  if ($null -ne $quality) {',
    '    try { $imageProcessor.Filters.Item(1).Properties.Item("Quality").Value = $quality } catch {}',
    '  }',
    '  return $imageProcessor.Apply($image)',
    '}',
    '$dialog = New-Object -ComObject WIA.CommonDialog',
    '$deviceManager = New-Object -ComObject WIA.DeviceManager',
    '$device = $null',
    'if ([string]::IsNullOrWhiteSpace($scannerDeviceId)) {',
    '  $device = $dialog.ShowSelectDevice(1, $true, $false)',
    '} else {',
    '  $deviceInfo = $deviceManager.DeviceInfos | Where-Object { $_.DeviceID -eq $scannerDeviceId } | Select-Object -First 1',
    '  if ($null -eq $deviceInfo) {',
    '    $device = $dialog.ShowSelectDevice(1, $true, $false)',
    '  } else {',
    '    $device = Connect-ScannerDevice $deviceInfo',
    '  }',
    '}',
    'if ($null -eq $device) { throw "Scanner device selection was cancelled." }',
    '$item = $device.Items.Item(1)',
    '$image = $item.Transfer()',
    'if ($null -eq $image) { throw "Scanner capture was cancelled." }',
    '$formats = @(',
    "  @{ name = 'bmp'; extension = 'bmp'; guid = '{B96B3CAB-0728-11D3-9D7B-0000F81EF32E}' },",
    "  @{ name = 'png'; extension = 'png'; guid = '{B96B3CAF-0728-11D3-9D7B-0000F81EF32E}' },",
    "  @{ name = 'jpeg'; extension = 'jpg'; guid = '{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}' }",
    ')',
    '$lastFormatError = $null',
    'foreach ($format in $formats) {',
    '  try {',
    '    $quality = $null',
    '    if ($format.name -eq "jpeg") { $quality = 85 }',
    '    $converted = Convert-ScannerImage $image $format.guid $quality',
    '    if ($null -eq $converted) { continue }',
    '    $outputPath = Join-Path $tempDir ($baseName + "." + $format.extension)',
    '    if (Test-Path $outputPath) { Remove-Item $outputPath -Force -ErrorAction SilentlyContinue }',
    '    $converted.SaveFile($outputPath)',
    '    if (Test-Path $outputPath) {',
    '      [PSCustomObject]@{ path = $outputPath; format = $format.name } | ConvertTo-Json -Compress',
    '      exit 0',
    '    }',
    '  } catch {',
    '    $lastFormatError = $_.Exception.Message',
    '  }',
    '}',
    'try {',
    '  $converted = Convert-ScannerImage $image "{B96B3CAB-0728-11D3-9D7B-0000F81EF32E}" $null',
    '  if ($null -eq $converted) { throw "Scanner conversion failed." }',
    '  $outputPath = Join-Path $tempDir ($baseName + ".bmp")',
    '  if (Test-Path $outputPath) { Remove-Item $outputPath -Force -ErrorAction SilentlyContinue }',
    '  $converted.SaveFile($outputPath)',
    '  [PSCustomObject]@{ path = $outputPath; format = "native" } | ConvertTo-Json -Compress',
    '} catch {',
    '  if ($lastFormatError) {',
    '    throw ("Scanner transfer failed. Preferred formats could not be captured. Last format error: " + $lastFormatError + ". Native fallback error: " + $_.Exception.Message)',
    '  }',
    '  throw',
    '}',
  ].join('\n');

  let tempFile = null;
  let normalizedTempFile = null;

  try {
    const { stdout } = await runPowerShellScript(script, 120000);
    const payload = String(stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .pop();

    if (!payload) {
      throw new Error('Scanner did not return a file path.');
    }

    const parsed = JSON.parse(payload);
    tempFile = typeof parsed?.path === 'string' ? parsed.path : null;

    if (!fs.existsSync(tempFile)) {
      throw new Error('Scanner did not return an image file.');
    }

    const scannedBuffer = fs.readFileSync(tempFile);

    try {
      return await normalizeScannedImageBuffer(scannedBuffer);
    } catch (error) {
      const signature = getBufferSignature(scannedBuffer);
      if (!signature.startsWith('424d')) {
        throw error;
      }

      const normalized = await normalizeScannedImageFileOnWindows(tempFile);
      normalizedTempFile = normalized.outputPath;
      return normalized.buffer;
    }
  } catch (error) {
    if (error && (error.killed || error.signal === 'SIGTERM')) {
      throw new Error('Scanner dialog timeout. Make sure the dialog is visible and complete scan within 2 minutes.');
    }
    const detail = String(error?.message || '').toLowerCase();
    if (detail.includes('wia') && detail.includes('class not registered')) {
      throw new Error('WIA is not available on this machine. Install scanner drivers with WIA support.');
    }
    if (detail.includes('device is busy')) {
      throw new Error('Scanner is busy. Close Epson Scan or other scanner apps, wait a few seconds, then try again.');
    }
    throw error;
  } finally {
    if (tempFile && fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
    if (normalizedTempFile && fs.existsSync(normalizedTempFile)) {
      fs.unlinkSync(normalizedTempFile);
    }
  }
}

app.use(express.json());
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error('Not allowed by CORS'));
  },
}));
app.use(connectorAuth);
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/capabilities', (_req, res) => {
  res.json(getCapabilities());
});

app.get('/api/scanner/devices', async (_req, res) => {
  try {
    const capabilities = getCapabilities();
    if (!capabilities.hardwareScanner.supported) {
      return res.status(501).json({ error: capabilities.hardwareScanner.reason, devices: [] });
    }

    const devices = await listWindowsScanners();
    return res.json({ devices });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to list scanners', devices: [] });
  }
});

app.get('/api/calibration/default', (_req, res) => {
  res.json({ calibration: DEFAULT_CALIBRATION });
});

app.post('/api/scan', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const total = Number(req.body.total || 35);
    const lang = String(req.body.lang || 'eng');
    const rotation = sanitizeRotation(req.body.rotation || 0);
    const keyMap = getKeyMap();
    const calibration = req.body.calibration ? sanitizeCalibration(JSON.parse(String(req.body.calibration))) : DEFAULT_CALIBRATION;

    const result = await scanBuffer({
      fileBuffer: req.file.buffer,
      keyMap,
      total,
      lang,
      rotation,
      includeDebug: String(req.body.debug || 'true') !== 'false',
      calibration,
    });

    return res.json({
      fileName: req.file.originalname,
      ...result,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Scan failed' });
  }
});

app.post('/api/scan-hardware', upload.none(), async (req, res) => {
  try {
    const capabilities = getCapabilities();
    if (!capabilities.hardwareScanner.supported) {
      return res.status(501).json({ error: capabilities.hardwareScanner.reason });
    }

    const body = req.body || {};
    const total = Number(body.total || 35);
    const lang = String(body.lang || 'eng');
    const rotation = sanitizeRotation(body.rotation || 0);
    const scannerDeviceId = String(body.scannerDeviceId || '').trim();
    const keyMap = getKeyMap();
    const calibration = body.calibration ? sanitizeCalibration(JSON.parse(String(body.calibration))) : DEFAULT_CALIBRATION;
    const scannedBuffer = await acquireFromWindowsScanner(scannerDeviceId);

    const result = await scanBuffer({
      fileBuffer: scannedBuffer,
      keyMap,
      total,
      lang,
      rotation,
      includeDebug: String(body.debug || 'true') !== 'false',
      calibration,
    });

    return res.json({
      fileName: `hardware_scan_${Date.now()}.jpg`,
      ...result,
    });
  } catch (error) {
    const message = error.message || 'Hardware scan failed';
    const lowered = message.toLowerCase();
    const status = lowered.includes('cancel') ? 400 : 500;
    return res.status(status).json({ error: message });
  }
});

app.post('/api/scan-bulk', upload.array('files', 30), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const total = Number(req.body.total || 35);
    const lang = String(req.body.lang || 'eng');
    const rotation = sanitizeRotation(req.body.rotation || 0);
    const keyMap = getKeyMap();
    const calibration = req.body.calibration ? sanitizeCalibration(JSON.parse(String(req.body.calibration))) : DEFAULT_CALIBRATION;

    const items = [];

    for (const file of req.files) {
      const scan = await scanBuffer({
        fileBuffer: file.buffer,
        keyMap,
        total,
        lang,
        rotation,
        includeDebug: false,
        calibration,
      });

      items.push({
        fileName: file.originalname,
        ...scan,
      });
    }

    const summary = items.reduce(
      (acc, item) => {
        if (!item.score) {
          return acc;
        }

        acc.totalFiles += 1;
        acc.correct += item.score.correct;
        acc.wrong += item.score.wrong;
        acc.questions += item.score.total;
        return acc;
      },
      { totalFiles: 0, correct: 0, wrong: 0, questions: 0 }
    );

    summary.score = summary.questions
      ? Number(((summary.correct / summary.questions) * 100).toFixed(2))
      : 0;

    return res.json({
      summary,
      items,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Bulk scan failed' });
  }
});

app.get('/api/answer-key/template', (_req, res) => {
  const totalQuestions = Number(_req.query.total || 35);
  const template = generateAnswerKeyTemplate(totalQuestions);

  res.set('Content-Type', 'application/json');
  res.set('Content-Disposition', `attachment; filename="answer_key_template_${totalQuestions}.json"`);
  res.send(JSON.stringify(template, null, 2));
});

app.post('/api/answer-key/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const totalQuestions = Number(req.body.total || 35);
    let keyObj;

    if (req.file.mimetype === 'application/json' || req.file.originalname.endsWith('.json')) {
      keyObj = JSON.parse(req.file.buffer.toString('utf-8'));
    } else {
      keyObj = parseAnswerKeyFromText(req.file.buffer.toString('utf-8'));
    }

    const validation = validateAnswerKey(keyObj, totalQuestions);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'Invalid answer key',
        errors: validation.errors,
        warnings: validation.warnings,
      });
    }

    fs.writeFileSync(defaultKeyPath, JSON.stringify(keyObj, null, 2));

    return res.json({
      success: true,
      message: `Answer key uploaded with ${Object.keys(keyObj).length} questions`,
      warnings: validation.warnings,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Key upload failed' });
  }
});

app.get('/api/answer-key/current', (_req, res) => {
  if (!fs.existsSync(defaultKeyPath)) {
    return res.json({ loaded: false, key: null });
  }

  const keyObj = JSON.parse(fs.readFileSync(defaultKeyPath, 'utf-8'));
  const total = Object.keys(keyObj).length;

  return res.json({
    loaded: true,
    count: total,
    preview: Object.fromEntries(Object.entries(keyObj).slice(0, 5)),
  });
});

app.listen(PORT, HOST, () => {
  const boundHost = HOST === '0.0.0.0' ? 'all interfaces' : HOST;
  console.log(`OCR web server running at http://${boundHost}:${PORT}`);
  console.log(`Connector token: ${CONNECTOR_TOKEN ? 'enabled' : 'disabled'}`);
  if (ALLOWED_ORIGINS.length > 0) {
    console.log(`CORS origins: ${ALLOWED_ORIGINS.join(', ')}`);
  }
});
