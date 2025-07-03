// Test script for time conversion functions
const { convertCTtoUTC, convertUTCtoCT } = require('./routes/clients/makeup-artist/webhook.js');

// Test the time conversion functions
function testTimeConversion() {
  console.log('Testing time conversion functions (now storing in Central Time format)...\n');
  
  // Test case 1: Your original test case
  const testTime = "2025-07-17T14:00:00";
  console.log(`Test 1: Converting Central Time for database storage`);
  console.log(`Input (CT): ${testTime}`);
  
  const storedTime = convertCTtoUTC(testTime);
  console.log(`Stored in DB: ${storedTime}`);
  
  // Convert back from DB
  const backToCT = convertUTCtoCT(storedTime);
  console.log(`Read from DB: ${backToCT}`);
  console.log(`Match: ${testTime === backToCT ? '✅' : '❌'}\n`);
  
  // Test case 2: Different time
  const testTime2 = "2025-01-15T09:30:00";
  console.log(`Test 2: Converting Central Time for database storage (winter time)`);
  console.log(`Input (CT): ${testTime2}`);
  
  const storedTime2 = convertCTtoUTC(testTime2);
  console.log(`Stored in DB: ${storedTime2}`);
  
  const backToCT2 = convertUTCtoCT(storedTime2);
  console.log(`Read from DB: ${backToCT2}`);
  console.log(`Match: ${testTime2 === backToCT2 ? '✅' : '❌'}\n`);
  
  // Test case 3: Edge case - midnight
  const testTime3 = "2025-07-17T00:00:00";
  console.log(`Test 3: Converting Central Time for database storage (midnight)`);
  console.log(`Input (CT): ${testTime3}`);
  
  const storedTime3 = convertCTtoUTC(testTime3);
  console.log(`Stored in DB: ${storedTime3}`);
  
  const backToCT3 = convertUTCtoCT(storedTime3);
  console.log(`Read from DB: ${backToCT3}`);
  console.log(`Match: ${testTime3 === backToCT3 ? '✅' : '❌'}\n`);
  
  console.log('Note: Times are now stored in Central Time format in the database.');
  console.log('This means your n8n workflow will see Central Time directly!');
}

// Run the test
testTimeConversion(); 