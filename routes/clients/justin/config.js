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
    location: 'UC Davis Campus, 1213 Alvarado Ave #84, Davis CA 95616'
  },
  
  // Validation helper function - UPDATED to check both Thursday and Friday
  isValidAppointmentTime: function(dateTime) {
    const date = new Date(dateTime);
    const day = date.getDay();
    const hour = date.getHours();
    
    if (day === this.availability.thursday.day) {
      // Thursday validation (6 PM - 10 PM)
      return hour >= this.availability.thursday.startHour && 
             hour < this.availability.thursday.endHour;
    }
    else if (day === this.availability.friday.day) {
      // Friday validation (2 PM - 8 PM)
      return hour >= this.availability.friday.startHour && 
             hour < this.availability.friday.endHour;
    }
    
    // Not Thursday or Friday
    return false;
  }
};