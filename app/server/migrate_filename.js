const fs = require('fs');
const path = require('path');

const recordsPath = path.join(__dirname, 'records.json');

if (fs.existsSync(recordsPath)) {
  const data = fs.readFileSync(recordsPath, 'utf8');
  let records = JSON.parse(data);
  let changed = false;

  const migrate = (obj) => {
    if (!obj) return;
    if (Array.isArray(obj)) {
      obj.forEach(migrate);
    } else if (typeof obj === 'object') {
      if (obj.hasOwnProperty('file_name')) {
        obj.fileName = obj.file_name;
        delete obj.file_name;
        changed = true;
      }
      for (let key in obj) {
        migrate(obj[key]);
      }
    }
  };

  migrate(records);

  if (changed) {
    fs.writeFileSync(recordsPath, JSON.stringify(records, null, 2));
    console.log('Migration successful. Replaced all file_name with fileName.');
  } else {
    console.log('No migration needed.');
  }
} else {
  console.log('No records.json found.');
}
