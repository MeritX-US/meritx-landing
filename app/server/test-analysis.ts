import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { runPlaybookAnalysis } from './playbookEngine';

let envPath = path.join(__dirname, '.env');
if (!fs.existsSync(envPath)) {
  envPath = path.join(__dirname, '../.env');
}
dotenv.config({ path: envPath });

async function test() {
  let recordsPath = path.join(__dirname, 'records.json');
  if (!fs.existsSync(recordsPath)) {
    recordsPath = path.join(__dirname, '../records.json');
  }
  if (!fs.existsSync(recordsPath)) {
    console.error('records.json not found at:', recordsPath);
    return;
  }
  
  const records = JSON.parse(fs.readFileSync(recordsPath, 'utf8'));
  const record = records[0];
  if (!record) {
    console.error('No record found!');
    return;
  }

  console.log('Record ID:', record.id);
  console.log('Items:', record.items?.map((i: any) => i.name));

  const recordText = record.transcript ? record.transcript.text : "";
  const allMediaParts: any[] = [];
  
  if (record.items) {
    for (const item of record.items) {
      if (item.type === 'image' || item.type === 'pdf') {
        let filePath = path.join(__dirname, item.url.replace('/uploads', 'uploads'));
        if (!fs.existsSync(filePath)) {
          filePath = path.join(__dirname, '../', item.url.replace('/uploads', 'uploads'));
        }
        if (fs.existsSync(filePath)) {
          const data = fs.readFileSync(filePath);
          allMediaParts.push({
            inlineData: {
              data: data.toString('base64'),
              mimeType: item.metadata?.mimetype || (item.type === 'image' ? 'image/jpeg' : 'application/pdf')
            }
          });
          console.log('Loaded media:', item.name, 'Size:', data.length);
        } else {
          console.warn('File not found:', filePath);
        }
      }
    }
  }

  try {
    console.log('Running analysis...');
    const result = await runPlaybookAnalysis(recordText, allMediaParts, record.items || []);
    console.log('Analysis completed successfully!');
    console.log('Scenario:', result.scenarioLabel);
    console.log('Completeness score:', result.completeness.overall);
    console.log('Document checklist status:');
    result.documents.forEach((doc: any) => {
      console.log(`- ${doc.label}: ${doc.status} (${doc.fileName || 'none'})`);
    });
    console.log('Evidence mappings:');
    result.evidence.forEach((ev: any) => {
      console.log(`- [${ev.category}] ${ev.type}: ${ev.fileName} (Strength: ${ev.strength})`);
    });
  } catch (err: any) {
    console.error('Analysis failed with error:', err.message);
    if (err.stack) console.error(err.stack);
  }
}

test();
