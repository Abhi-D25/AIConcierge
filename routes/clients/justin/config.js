/**
 * Configuration specific to Justin's barber service
 */
module.exports = {
  // Justin's barber ID in the database
  JUSTIN_BARBER_ID: process.env.JUSTIN_BARBER_ID || 'your-justin-uuid-here',
  
  // Calendar settings
  calendar: {
    calendarId: 'primary',
    timeZone: 'America/Los_Angeles'
  },
  
  // Services offered
  services: [
    { name: 'Haircut', duration: 30, price: 20 },
    { name: 'Beard Trim', duration: 15, price: 10 },
    { name: 'Haircut & Beard', duration: 45, price: 25 }
  ],
  
  // Availability constraints - UPDATED to match the prompt
  availability: {
    thursday: {
      day: 4, // Thursday (0 = Sunday, 4 = Thursday)
      startHour: 18, // 6 PM
      endHour: 22,   // 10 PM
    },
    friday: {
      day: 5, // Friday
      startHour: 14, // 2 PM
      endHour: 20,   // 8 PM
    },
    location: '1213 Alvarado Ave #84, Davis CA 95616'
  },
  
  // Validation helper function - UPDATED to check both Thursday and Friday
  isValidAppointmentTime: function(dateTimeStr) {
    // Parse the input datetime string directly
    const date = new Date(dateTimeStr);
    
    // Debug info
    console.log('Validating date:', {
      input: dateTimeStr,
      parsed: date.toString(),
      day: date.getDay(),
      hour: date.getHours()
    });
    
    // Check for Thursday (day 4) or Friday (day 5)
    const day = date.getDay();
    const hour = date.getHours();
    
    if (day === 4) { // Thursday
      // Valid hours: 6 PM - 10 PM (18:00 - 22:00)
      return hour >= 18 && hour < 22;
    } 
    else if (day === 5) { // Friday
      // Valid hours: 2 PM - 8 PM (14:00 - 20:00)
      return hour >= 14 && hour < 20;
    }
    
    // Not a Thursday or Friday
    return false;
  }
};