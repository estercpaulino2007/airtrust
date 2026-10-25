// 12 simulated low-cost sensors across Istanbul, on both sides of the Bosphorus. Coordinates are
// approximate centroids of real districts and landmarks; the devices and their readings are
// SIMULATED and labelled as such everywhere in the UI.
//
// The layout keeps the relationships the demo scenarios rely on: a westerly wind carries smoke from
// the İkitelli industrial zone (AT-007) toward Bağcılar (AT-004) and Başakşehir (AT-009).
module.exports = [
  { code: "AT-001", name: "Sultanahmet Square", district: "Fatih", latitude: 41.0082, longitude: 28.9784, profile: "urban" },
  { code: "AT-002", name: "Mecidiyeköy Junction", district: "Şişli", latitude: 41.0675, longitude: 28.9940, profile: "traffic" },
  { code: "AT-003", name: "Barbaros Boulevard", district: "Beşiktaş", latitude: 41.0430, longitude: 29.0070, profile: "urban" },
  { code: "AT-004", name: "Bağcılar Square", district: "Bağcılar", latitude: 41.0390, longitude: 28.8560, profile: "urban" },
  { code: "AT-005", name: "Emirgan Park", district: "Sarıyer", latitude: 41.1080, longitude: 29.0530, profile: "green" },
  { code: "AT-006", name: "Kadıköy Pier", district: "Kadıköy", latitude: 40.9900, longitude: 29.0280, profile: "traffic" },
  { code: "AT-007", name: "İkitelli Industrial Zone", district: "İkitelli", latitude: 41.0690, longitude: 28.8010, profile: "industrial" },
  { code: "AT-008", name: "Dudullu Industrial Zone", district: "Ümraniye", latitude: 41.0000, longitude: 29.1600, profile: "industrial" },
  { code: "AT-009", name: "Başakşehir Park", district: "Başakşehir", latitude: 41.0930, longitude: 28.8020, profile: "green" },
  { code: "AT-010", name: "Halkalı School", district: "Küçükçekmece", latitude: 41.0300, longitude: 28.7700, profile: "urban" },
  { code: "AT-011", name: "Pendik Health Centre", district: "Pendik", latitude: 40.8770, longitude: 29.2350, profile: "urban" },
  { code: "AT-012", name: "Ataşehir Logistics Depot", district: "Ataşehir", latitude: 40.9920, longitude: 29.1240, profile: "industrial" },
];
