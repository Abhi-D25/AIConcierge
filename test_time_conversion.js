// Test script for time conversion functions
const { convertCTtoUTC, convertUTCtoCT } = require('./routes/clients/makeup-artist/webhook.js');

// Test the time conversion functions
function testTimeConversion() {
  console.log('Testing time conversion functions...\n');
  
  // Test case 1: Your original test case
  const testTime = "2025-07-17T14:00:00";
  console.log(`Test 1: Converting Central Time to UTC`);
  console.log(`Input (CT): ${testTime}`);
  
  const utcTime = convertCTtoUTC(testTime);
  console.log(`Output (UTC): ${utcTime}`);
  
  // Convert back to CT
  const backToCT = convertUTCtoCT(utcTime);
  console.log(`Back to CT: ${backToCT}`);
  console.log(`Match: ${testTime === backToCT ? '✅' : '❌'}\n`);
  
  // Test case 2: Different time
  const testTime2 = "2025-01-15T09:30:00";
  console.log(`Test 2: Converting Central Time to UTC (winter time)`);
  console.log(`Input (CT): ${testTime2}`);
  
  const utcTime2 = convertCTtoUTC(testTime2);
  console.log(`Output (UTC): ${utcTime2}`);
  
  const backToCT2 = convertUTCtoCT(utcTime2);
  console.log(`Back to CT: ${backToCT2}`);
  console.log(`Match: ${testTime2 === backToCT2 ? '✅' : '❌'}\n`);
  
  // Test case 3: Edge case - midnight
  const testTime3 = "2025-07-17T00:00:00";
  console.log(`Test 3: Converting Central Time to UTC (midnight)`);
  console.log(`Input (CT): ${testTime3}`);
  
  const utcTime3 = convertCTtoUTC(testTime3);
  console.log(`Output (UTC): ${utcTime3}`);
  
  const backToCT3 = convertUTCtoCT(utcTime3);
  console.log(`Back to CT: ${backToCT3}`);
  console.log(`Match: ${testTime3 === backToCT3 ? '✅' : '❌'}\n`);
}

// Run the test
testTimeConversion(); 