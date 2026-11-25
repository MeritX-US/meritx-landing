import fs from 'fs';
import os from 'os';
import path from 'path';
import { createDemoApp } from './demoApp';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meritx-synthetic-'));
const { app } = createDemoApp({
  root,
  password: process.env.PILOT_DEMO_PASSWORD?.trim() ?? '',
  organizerKey: process.env.PILOT_TRIAL_ORGANIZER_KEY?.trim(),
});
app.listen(Number(process.env.PORT || 3101), () => console.log('[pilot] synthetic demo listening'));
