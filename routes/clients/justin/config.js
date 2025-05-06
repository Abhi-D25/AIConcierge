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
    
    // Availability constraints
    availability: {
      day: 4, // Thursday (0 = Sunday, 4 = Thursday)
      startHour: 13, // 1 PM
      endHour: 17,   // 5 PM
      location: 'UC Davis Campus'
    },
    
    // Validation helper function
    isValidThursdayTime: function(dateTime) {
      const date = new Date(dateTime);
      return date.getDay() === this.availability.day && // Thursday
             date.getHours() >= this.availability.startHour && // After 1 PM
             date.getHours() < this.availability.endHour;    // Before 5 PM
    }
  };