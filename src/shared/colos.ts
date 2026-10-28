/**
 * City names for Cloudflare data centers, by the IATA airport code Cloudflare
 * reports (`colo=FRA` in its trace), for showing where a re-check ran
 * ("Confirmed from Frankfurt"; docs/SECOND_REGION.md). It covers the data
 * centers Durable Objects run in and the larger ones around them; any other
 * code is shown as is.
 */
const COLO_CITIES: Record<string, string> = {
  // North America
  ATL: "Atlanta",
  BOS: "Boston",
  DEN: "Denver",
  DFW: "Dallas",
  EWR: "Newark",
  IAD: "Ashburn",
  IAH: "Houston",
  LAX: "Los Angeles",
  MIA: "Miami",
  MSP: "Minneapolis",
  ORD: "Chicago",
  PDX: "Portland",
  PHX: "Phoenix",
  SEA: "Seattle",
  SJC: "San Jose",
  SLC: "Salt Lake City",
  YUL: "Montreal",
  YVR: "Vancouver",
  YYZ: "Toronto",
  MEX: "Mexico City",
  // South America
  BOG: "Bogota",
  EZE: "Buenos Aires",
  GRU: "Sao Paulo",
  LIM: "Lima",
  SCL: "Santiago",
  // Europe
  AMS: "Amsterdam",
  ARN: "Stockholm",
  ATH: "Athens",
  BCN: "Barcelona",
  BRU: "Brussels",
  BUD: "Budapest",
  CDG: "Paris",
  CPH: "Copenhagen",
  DUB: "Dublin",
  DUS: "Dusseldorf",
  FRA: "Frankfurt",
  HAM: "Hamburg",
  HEL: "Helsinki",
  IST: "Istanbul",
  KBP: "Kyiv",
  LHR: "London",
  LIS: "Lisbon",
  MAD: "Madrid",
  MAN: "Manchester",
  MRS: "Marseille",
  MUC: "Munich",
  MXP: "Milan",
  OSL: "Oslo",
  OTP: "Bucharest",
  PRG: "Prague",
  SOF: "Sofia",
  VIE: "Vienna",
  WAW: "Warsaw",
  ZRH: "Zurich",
  // Middle East and Africa
  DXB: "Dubai",
  TLV: "Tel Aviv",
  DOH: "Doha",
  JNB: "Johannesburg",
  CPT: "Cape Town",
  LOS: "Lagos",
  NBO: "Nairobi",
  CAI: "Cairo",
  // Asia-Pacific
  BKK: "Bangkok",
  BOM: "Mumbai",
  CGK: "Jakarta",
  DEL: "New Delhi",
  HKG: "Hong Kong",
  ICN: "Seoul",
  KIX: "Osaka",
  KUL: "Kuala Lumpur",
  MAA: "Chennai",
  MNL: "Manila",
  NRT: "Tokyo",
  SIN: "Singapore",
  TPE: "Taipei",
  // Oceania
  AKL: "Auckland",
  BNE: "Brisbane",
  MEL: "Melbourne",
  PER: "Perth",
  SYD: "Sydney",
};

/** "Frankfurt" for "FRA"; an unknown code comes back as it is. */
export function coloCity(code: string): string {
  return COLO_CITIES[code.toUpperCase()] ?? code.toUpperCase();
}
