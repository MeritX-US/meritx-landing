const fs = require('fs');
const path = require('path');

const recordsPath = path.join(__dirname, 'records.json');
const backupPath = path.join(__dirname, 'records.json.bak');

function migrate() {
    if (!fs.existsSync(recordsPath)) {
        console.error('❌ records.json not found in the current directory.');
        return;
    }

    try {
        const rawData = fs.readFileSync(recordsPath, 'utf8');
        const records = JSON.parse(rawData);

        console.log(`🔍 Found ${records.length} records. Starting migration...`);

        // Create backup
        fs.writeFileSync(backupPath, rawData);
        console.log(`💾 Backup created at ${backupPath}`);

        let migratedCount = 0;

        const migratedRecords = records.map(record => {
            // Check if it's already a "matter" type or has items
            if (record.type === 'matter' && record.items) {
                return record;
            }

            migratedCount++;

            // Convert to Matter Collection format
            const items = [];

            // If it had a top-level audioUrl, move it to an item
            if (record.audioUrl) {
                items.push({
                    type: 'audio',
                    url: record.audioUrl,
                    name: 'Original Recording'
                });
            }

            // Construct new record
            return {
                id: record.id,
                timestamp: record.timestamp,
                type: 'matter',
                items: items,
                summary: record.summary,
                transcript: record.transcript,
                ...record // Keep any other custom fields
            };
        });

        fs.writeFileSync(recordsPath, JSON.stringify(migratedRecords, null, 2));
        console.log(`✅ Migration complete! ${migratedCount} records updated.`);
        console.log('🚀 You can now restart your server.');

    } catch (error) {
        console.error('❌ Migration failed:', error.message);
    }
}

migrate();
