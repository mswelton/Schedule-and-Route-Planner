/**
 * GET /api/locations
 *
 * Returns every active service location (with a readable client name) plus the
 * base location for the day. Coordinates come straight off the row; the
 * composed address string is the geocoding fallback for rows missing them.
 */

import { serverSupabase, scopeToUser, formatAddress } from '../lib/supabase.js';
import { DEFAULT_TIMEZONE } from '../lib/time.js';

function toLocation(row) {
  const client = row.clients
    ? [row.clients.first_name, row.clients.last_name].filter(Boolean).join(' ')
    : null;

  return {
    id: row.id,
    name: row.location_name,
    yard: row.yard_stable_name || null,
    clientName: client || null,
    townCity: row.town_city || null,
    county: row.county || null,
    address: formatAddress(row),
    lat: row.latitude,
    lng: row.longitude,
    hasCoords: Number.isFinite(row.latitude) && Number.isFinite(row.longitude),
    accessNotes: row.access_notes || null,
    isHome: row.is_home === true,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const supabase = serverSupabase();
    const query = scopeToUser(
      supabase
        .from('service_locations')
        .select(
          // The FK is named explicitly: service_locations has two foreign keys
          // to clients (client_id and created_by_client_id), so an unqualified
          // `clients(...)` embed is ambiguous and PostgREST rejects it.
          'id, location_name, yard_stable_name, address_line1, address_line2, town_city, county, postcode, latitude, longitude, access_notes, is_home, clients!service_locations_client_id_fkey ( first_name, last_name )'
        )
        .eq('is_archived', false)
        .order('location_name', { ascending: true })
    );

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const locations = (data || []).map(toLocation);

    // Base address resolution, in priority order:
    //   1. the service_location flagged is_home (Mark's own property)
    //   2. a BASE_ADDRESS env override
    //   3. nothing — the UI asks for one and stores it locally
    const home = locations.find((loc) => loc.isHome) || null;
    const envBase = process.env.BASE_ADDRESS
      ? {
          id: 'env-base',
          name: process.env.BASE_ADDRESS_LABEL || 'Base',
          address: process.env.BASE_ADDRESS,
          lat: null,
          lng: null,
          hasCoords: false,
          source: 'env',
        }
      : null;

    const defaultBase = home ? { ...home, source: 'service_locations.is_home' } : envBase;

    return res.status(200).json({
      locations,
      defaultBase,
      timezone: DEFAULT_TIMEZONE,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
