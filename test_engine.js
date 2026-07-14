const fs = require('fs');
const { runPlaybookAnalysis } = require('./app/server/dist/playbookEngine');

async function test() {
    try {
        const recordText = "Hello, I want to apply for a visa.";
        const mediaParts = []; // no files
        const existingItems = [];
        
        console.log("Running analysis...");
        const result = await runPlaybookAnalysis(recordText, mediaParts, existingItems, "unknown");
        console.log("Success!");
        console.log(JSON.stringify(result, null, 2));
    } catch (err) {
        console.error("Caught an error:", err);
    }
}

test();
