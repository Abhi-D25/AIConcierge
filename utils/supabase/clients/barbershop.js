const { createSupabaseClient, createClientOperations } = require('../base');
require('dotenv').config();

// Get Barbershop-specific Supabase credentials from environment variables
// If specific credentials aren't provided, fall back to the default ones
const supabaseUrl = process.env.BARBERSHOP_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.BARBERSHOP_SUPABASE_KEY || process.env.SUPABASE_KEY;

// Create Supabase client for Barbershop
const supabase = createSupabaseClient(supabaseUrl, supabaseKey);

// Create operations using this client
// This gives us all the standard operations defined in base.js
const operations = createClientOperations(supabase);

// You can extend or override specific operations if needed for barbershop-specific functionality
// For example:

// Add a barbershop-specific method for getting barbers with specialties
operations.barberOps.getBarbersWithSpecialties = async () => {
  const { data, error } = await supabase
    .from('barbers')
    .select('id, name, specialties')
    .order('name');
    
  if (error) {
    console.error('Error fetching barbers with specialties:', error);
    return [];
  }
  
  return data;
};

// Add a method for checking barbershop business hours
operations.getBusinessHours = async () => {
  const { data, error } = await supabase
    .from('barbershop_settings')
    .select('business_hours')
    .single();
    
  if (error) {
    console.error('Error fetching business hours:', error);
    return {
      monday: { open: '09:00', close: '18:00' },
      tuesday: { open: '09:00', close: '18:00' },
      wednesday: { open: '09:00', close: '18:00' },
      thursday: { open: '09:00', close: '18:00' },
      friday: { open: '09:00', close: '18:00' },
      saturday: { open: '10:00', close: '16:00' },
      sunday: { open: null, close: null },
    };
  }
  
  return data.business_hours;
};

// Export the operations
module.exports = operations;