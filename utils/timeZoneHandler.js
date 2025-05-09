function parseDateTime(dateTimeString, clientType = 'barbershop') {
    // Clean up date string if it has millisecond precision
    let cleanDateString = dateTimeString;
    if (dateTimeString.includes('.')) {
      cleanDateString = dateTimeString.replace(/\.\d+(?=[Z+-])/, '');
    }
    
    try {
      // CRITICAL CHANGE: If dateTimeString has no timezone indicator, assume it's already CT
      // and create a Date object directly without timezone conversion
      if (!cleanDateString.match(/[Z+-]/)) {
        // Parse the ISO string components
        const match = cleanDateString.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
        if (match) {
          const [_, year, month, day, hour, minute, second] = match;
          
          // Create a direct Date object in CT (local time of the specified components)
          // without applying any timezone offset
          return new Date(year, month - 1, day, hour, minute, second);
        }
      }
      
      // For strings with timezone indicators (Z/+/-), use standard parsing
      const date = new Date(cleanDateString);
      if (!isNaN(date.getTime())) return date;
    } catch (e) {
      console.error('Error parsing date:', e);
    }
    
    // Fall back to old manual parsing if necessary - but keep this only for backward compatibility
    const match = cleanDateString.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
    if (!match) throw new Error(`Invalid date format: ${dateTimeString}`);
    
    const [_, year, month, day, hour, minute, second] = match;
    
    // CRITICAL: Create date directly without timezone conversion
    return new Date(year, month - 1, day, hour, minute, second);
  }
  
  // With this change, when times are sent without timezone indicators (like 2025-05-16T15:00:00),
  // they will be treated as already being in Central Time, and no further conversion will be applied.
  
  // Also update the formatToTimeZone function to ensure consistent timezone handling:
  function formatToTimeZone(date, clientType = 'barbershop') {
    const timeZone = clientType === 'makeup_artist' ? 'America/Chicago' : 'America/Los_Angeles';
    
    // Format directly without converting the time
    return {
      dateTime: date.toISOString().replace(/\.\d{3}Z$/, ''),
      timeZone: timeZone
    };
  }
  
  module.exports = {
    parseDateTime,
    formatToTimeZone
  };