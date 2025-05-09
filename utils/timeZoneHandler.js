function parseDateTime(dateTimeString, clientType = 'barbershop') {
    // Clean up date string if it has millisecond precision
    let cleanDateString = dateTimeString;
    if (dateTimeString.includes('.')) {
      cleanDateString = dateTimeString.replace(/\.\d+(?=[Z+-])/, '');
    }
    
    try {
      // Try standard date parsing first
      const date = new Date(cleanDateString);
      if (!isNaN(date.getTime())) return date;
    } catch (e) {
      console.error('Error parsing date:', e);
    }
    
    // Fall back to manual parsing if necessary
    const match = cleanDateString.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
    if (!match) throw new Error(`Invalid date format: ${dateTimeString}`);
    
    const [_, year, month, day, hour, minute, second] = match;
    
    // Use different UTC offset based on client type
    if (clientType === 'makeup_artist') {
      // For makeup artist, use Central Time (UTC-6) 
      return new Date(Date.UTC(+year, +month - 1, +day, +hour + 6, +minute, +second));
    } else {
      // For barbershop, use Pacific Time (UTC-7)
      return new Date(Date.UTC(+year, +month - 1, +day, +hour + 7, +minute, +second));
    }
  }
  
  // Function to format date to ISO string with time zone
  function formatToTimeZone(date, clientType = 'barbershop') {
    const timeZone = clientType === 'makeup_artist' ? 'America/Chicago' : 'America/Los_Angeles';
    return {
      dateTime: date.toISOString(),
      timeZone: timeZone
    };
  }
  
  module.exports = {
    parseDateTime,
    formatToTimeZone
  };