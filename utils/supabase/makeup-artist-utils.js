// utils/supabase/makeup-artist-utils.js
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Create Supabase client for Makeup Artists
const makeupArtistUrl = process.env.MAKEUP_ARTIST_SUPABASE_URL || process.env.SUPABASE_URL;
const makeupArtistKey = process.env.MAKEUP_ARTIST_SUPABASE_KEY || process.env.SUPABASE_KEY;

if (!makeupArtistUrl || !makeupArtistKey) {
  console.error('Missing Makeup Artist Supabase credentials');
  // Don't exit - fall back to default if possible
}

const makeupArtistSupabase = createClient(makeupArtistUrl, makeupArtistKey);

// Makeup Artist operations
const makeupArtistOps = {
  // Get a makeup artist by phone number
  async getByPhoneNumber(phoneNumber) {
    console.log('Looking up makeup artist with phone number:', phoneNumber);
    
    const { data, error } = await makeupArtistSupabase
      .from('makeup_artists')
      .select('*')
      .eq('phone_number', phoneNumber)
      .single();
      
    if (error && error.code !== 'PGRST116') {
      console.error('Error fetching makeup artist:', error);
    }
    
    return data;
  },
  
  // Create or update a makeup artist
  async updateOrCreate(artistData) {
    const { 
      phone_number, 
      name, 
      email, 
      refresh_token, 
      selected_calendar_id,
      business_hours_start,
      business_hours_end,
      business_type
    } = artistData;
    
    if (!phone_number) {
      console.error('Phone number is required for makeup artist');
      return null;
    }
    
    // Check if artist exists
    const existingArtist = await this.getByPhoneNumber(phone_number);
    
    try {
      if (existingArtist) {
        // Update existing artist
        const updateData = {
          updated_at: new Date()
        };
        
        // Only include fields that are provided
        if (name) updateData.name = name;
        if (email) updateData.email = email;
        if (refresh_token) updateData.refresh_token = refresh_token;
        if (selected_calendar_id) updateData.selected_calendar_id = selected_calendar_id;
        if (business_hours_start) updateData.business_hours_start = business_hours_start;
        if (business_hours_end) updateData.business_hours_end = business_hours_end;
        if (business_type) updateData.business_type = business_type;
        
        const { data, error } = await makeupArtistSupabase
          .from('makeup_artists')
          .update(updateData)
          .eq('phone_number', phone_number)
          .select();
          
        if (error) {
          console.error('Error updating makeup artist:', error);
          return null;
        }
        
        return data[0];
      } else {
        // Create new makeup artist
        const { data, error } = await makeupArtistSupabase
          .from('makeup_artists')
          .insert({
            phone_number,
            name: name || 'New Makeup Artist',
            email,
            refresh_token,
            selected_calendar_id: selected_calendar_id || 'primary',
            business_hours_start: business_hours_start || '09:00',
            business_hours_end: business_hours_end || '18:00',
            business_type: business_type || 'makeup_artist',
            created_at: new Date(),
            updated_at: new Date()
          })
          .select();
          
        if (error) {
          console.error('Error creating makeup artist:', error);
          return null;
        }
        
        return data[0];
      }
    } catch (err) {
      console.error('Exception in updateOrCreate makeup artist:', err);
      return null;
    }
  },
  
  // Update calendar ID for a makeup artist
  async updateCalendarId(phoneNumber, calendarId) {
    const { data, error } = await makeupArtistSupabase
      .from('makeup_artists')
      .update({
        selected_calendar_id: calendarId,
        updated_at: new Date()
      })
      .eq('phone_number', phoneNumber)
      .select();
      
    if (error) {
      console.error('Error updating makeup artist calendar ID:', error);
      return null;
    }
    
    return data[0];
  },
  
  // Get artist with refresh token
  async getWithRefreshToken() {
    const { data, error } = await makeupArtistSupabase
      .from('makeup_artists')
      .select('*')
      .not('refresh_token', 'is', null)
      .limit(1);
      
    if (error) {
      console.error('Error fetching makeup artist with refresh token:', error);
      return null;
    }
    
    return data[0];
  }
};

// Client operations
const clientOps = {
  // Get a client by phone number
  async getByPhoneNumber(phoneNumber) {
    const { data, error } = await makeupArtistSupabase
      .from('clients')
      .select('*')
      .eq('phone_number', phoneNumber)
      .single();
      
    if (error && error.code !== 'PGRST116') {
      console.error('Error fetching client:', error);
    }
    
    return data;
  },
  
  // Create or update a client
  async createOrUpdate(clientData) {
    const { 
      phone_number, 
      name, 
      email, 
      skin_type, 
      skin_tone,
      allergies,
      special_notes,
      preferred_service_type
    } = clientData;
    
    if (!phone_number) {
      console.error('Phone number is required for client');
      return null;
    }
    
    // Check if client exists
    const existingClient = await this.getByPhoneNumber(phone_number);
    
    try {
      if (existingClient) {
        // Update existing client
        const updateData = {
          updated_at: new Date()
        };
        
        // Only include fields that are provided
        if (name) updateData.name = name;
        if (email) updateData.email = email;
        if (skin_type) updateData.skin_type = skin_type;
        if (skin_tone) updateData.skin_tone = skin_tone;
        if (allergies) updateData.allergies = allergies;
        if (special_notes) updateData.special_notes = special_notes;
        if (preferred_service_type) updateData.preferred_service_type = preferred_service_type;
        
        const { data, error } = await makeupArtistSupabase
          .from('clients')
          .update(updateData)
          .eq('phone_number', phone_number)
          .select();
          
        if (error) {
          console.error('Error updating client:', error);
          return null;
        }
        
        return data[0];
      } else {
        // Create new client
        const { data, error } = await makeupArtistSupabase
          .from('clients')
          .insert({
            phone_number,
            name: name || 'New Client',
            email,
            skin_type,
            skin_tone,
            allergies,
            special_notes,
            preferred_service_type,
            created_at: new Date(),
            updated_at: new Date()
          })
          .select();
          
        if (error) {
          console.error('Error creating client:', error);
          return null;
        }
        
        return data[0];
      }
    } catch (err) {
      console.error('Exception in createOrUpdate client:', err);
      return null;
    }
  }
};

module.exports = {
  makeupArtistSupabase,
  makeupArtistOps,
  clientOps,
};