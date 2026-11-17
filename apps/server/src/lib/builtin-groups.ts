// Group lists for the built-in formats (docs/PROFILES.md, "The five profiles"), taken once from the
// Dictionarry formats on 2026-11-15. They are ordinary formats after that: edit them in Admin, nothing syncs them.

// Consistent WEB-DL groups (Dictionarry WEB-DL tiers 1–3).
export const GOOD_WEB_GROUPS: readonly string[] = [
  'FLUX', 'NTb', 'TheFarm', 'BYNDR', 'CMRG', 'HONE', 'Kitsune', 'playWEB', 'TEPES', 'ABM', 'AJP69', 'BLUTONiUM',
  'BTW', 'CasStudio', 'Cinefeel', 'CRFW', 'CtrlHD', 'HHWEB', 'KHN', 'KiNGS', 'LAZY', 'monkee', 'MZABI', 'NOSiViD',
  'NPMS', 'NTG', 'QOQ', 'RAWR', 'SA89', 'SbR', 'SMURF', 'TeamSyndicate', 'TOMMY', 'TVSmash', 'WELP', 'XEBEC',
  'ZoroSenpai',
];

// 1080p Blu-ray encoders with the best Golden Popcorn record (Dictionarry 1080p Quality tiers 1–3, by GPPi).
export const TOP_ENCODERS_GROUPS: readonly string[] = [
  'coffee', 'DON', 'REBORN', 'SA89', 'SoLaR', 'TeamSyndicate', 'ZoroSenpai', 'c0kE', 'CtrlHD', 'D-Z0N3', 'EbP',
  'Geek', 'HiFi', 'LoRD', 'TayTo', 'VietHD', 'ZQ', 'BV', 'CRiSC', 'decibeL', 'FoRM', 'HiDt', 'HiP', 'iFT', 'SbR',
  'WMING',
];

// 2160p Blu-ray encoders (Dictionarry 2160p Quality tiers 1–3, and HONE).
export const TOP_UHD_GROUPS: readonly string[] = [
  'DON', 'REBORN', 'SA89', 'SoLaR', 'CtrlHD', 'MainFrame', 'W4NK3R', 'BV', 'c0kE', 'Chotab', 'D-Z0N3', 'HQMUX',
  'PTer', 'TnP',
];

// Small, good x265 encodes (Dictionarry's High Efficiency and 1080p Compact tiers 1–2).
export const EFFICIENT_GROUPS: readonly string[] = [
  'PSA', 'ELiTE', 'MeGusta', 'QxR', 'afm72', 'Bandi', 'Bluespots', 'Celdra', 'FreetheFish', 'Garshasp', 'Ghost',
  'Ime', 'Kappa', 'Langbard', 'LION', 'Panda', 'MONOLITH', 'Natty', 'r00t', 'RCVR', 'RZeroX', 'SAMPA', 'Silence',
  't3nzin', 'Tigole', 'YOGI', 'TAoE', 'Ainz', 'AJJMIN', 'ANONAZ', 'ArcX', 'bccornfo', 'DNU', 'DrainedDay', 'DUHIT',
  'Erie', 'Frys', 'Goki', 'HxD', 'jb2049', 'JBENT', 'Nostradamus', 'r0b0t', 'Species180', 'TheSickle', 'xtrem3x',
  'WEM', 'Vialle', 'ARCADE', 'DarQ', 'LSt', 'ToNaTo', 'edge2020', 'GRiMM', 'OnlyWeb', 'YELLO', 'bluegreeen', 'dkore',
  'noxxus', 'Ralphy', 'TimeDistortion', 'Vyndros', 'HODL', 'iVy', 'KONTRAST', 'PHOCiS', 'YAWNiX', 'SQS', 'Chivaman',
  'R1GY3B',
];

// Groups known for bad or mislabelled releases (Dictionarry Banned Groups).
export const BANNED_GROUPS: readonly string[] = [
  '4K4U', 'AOC', 'AROMA', 'BeyondHD', 'BiTOR', 'BLASPHEMY', 'BOLS', 'BEN THE MEN', 'BEN', 'BTM', 'CLASSiCALHD',
  'CREATiVE24', 'd3g', 'DepraveD', 'DeViSiVE', 'DRX', 'E', 'FGT', 'Flights', 'HDS', 'iVy', 'jennaortegaUHD', 'KC',
  'LAMA', 'MeGusta', 'MgB', 'NAHOM', 'NhaNc3', 'NoGroup', 'OEPlus', 'PSA', 'RARBG', 'SasukeducK', 'SHD',
  'ShieldBearer', 'STUTTERSHIT', 'tarunk9c', 'TEKNO3D', 'Telly', 'TvR', 'UnKn0wn', 'VD0N', 'VECTOR', 'VisionXpert',
  'x0r', 'YIFY', 'YTS',
];
