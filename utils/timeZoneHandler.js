function parseDateTime(dateTimeString, clientType = 'barbershop') {
    // If the input doesn't have a time zone indicator, it's already in Central Time
    // Just create a Date object directly without any conversion
    if (!dateTimeString.match(/[Z+-]/)) {
      return new Date(dateTimeString);
    }
    
    // For dates with time zone indicators, use standard Date parsing
    return new Date(dateTimeString);
  }
  
  // Format a Date object to Google Calendar format with the correct time zone
  function formatToTimeZone(date, clientType = 'makeup_artist') {
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