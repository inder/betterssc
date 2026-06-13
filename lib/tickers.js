// Curated allowlist of bare-ticker symbols (no $ prefix) that should
// auto-link to a TradingView chart when they appear in a chat message.
//
// Scope: 3-5 letter, ALL-CAPS only. The matcher in lib/util.js requires
// case-sensitive whole-word match against this Set, which is why the
// false-positive surface is small — "Meta announced" doesn't match,
// only "META is up" does.
//
// Curation rules:
//   - Single-letter and 2-letter tickers EXCLUDED (T, F, GM, GE etc.)
//     The false-positive rate from English chat is too high to justify.
//   - Common English words that happen to be tickers EXCLUDED even when
//     they're real (ALL = Allstate, NEW, ANY, FOR, BIG, MOM, DOG, KEY,
//     JOY). User can $-prefix to disambiguate when they mean the ticker.
//   - Class-share tickers with dots (BRK.A, BRK.B) excluded for v1.
//     The simple \b[A-Z]{3,5}\b extractor doesn't capture them; use
//     $BRK.B if you mean the ticker.
//   - List is American-market biased plus top cryptos and broad
//     international ETFs. Roughly 300 symbols.
//
// Maintenance: add tickers as they come up in actual chat usage. The
// list is intentionally NOT a full S&P 500 dump — too many obscure
// tickers create more false-positive risk than value.
export const KNOWN_TICKERS = new Set([
  // ===== CRYPTO (3-letter) =====
  "BTC", "ETH", "BNB", "ADA", "SOL", "XRP", "DOT", "LTC", "BCH",
  "LINK", "ATOM", "ALGO", "NEAR", "RNDR", "INJ", "ORDI", "AVAX",
  // ===== CRYPTO (4-letter) =====
  "MATIC", "DOGE", "SHIB",

  // ===== INDICES =====
  "SPX", "NDX", "RUT", "VIX", "DJI", "NYA", "DXY", "COMP", "TNX",
  "INX", "HSI", "FTSE", "DAX",

  // ===== BROAD ETFs =====
  "SPY", "QQQ", "IWM", "DIA", "VTI", "VOO", "VEA", "VWO", "VXUS",
  "EFA", "EEM", "SCHB", "ITOT", "MDY",

  // ===== SECTOR ETFs (SPDR) =====
  "XLF", "XLE", "XLK", "XLY", "XLI", "XLU", "XLV", "XLP", "XLB",
  "XLC", "XLRE", "XBI", "XHB", "XRT", "XME", "XOP", "KRE", "KBE",
  "KBWB",

  // ===== SEMI / TECH ETFs =====
  "SMH", "SOXX", "SOXL", "SOXS", "FNGU", "FNGD", "PSI",

  // ===== LEVERAGED / INVERSE ETFs =====
  "TQQQ", "SQQQ", "UPRO", "SPXU", "SPXL", "FAS", "FAZ", "TNA",
  "TZA", "DRN", "DRV", "UVXY", "VIXY",

  // ===== BOND ETFs =====
  "TLT", "IEF", "AGG", "BND", "HYG", "JNK", "LQD", "EMB", "MUB",
  "SHY", "TIPS", "GOVT",

  // ===== COMMODITIES =====
  "GLD", "IAU", "SLV", "USO", "UCO", "UNG", "KOLD", "BOIL", "DBA",
  "DBC", "GDX", "GDXJ", "PALL", "PPLT",

  // ===== ARK =====
  "ARKK", "ARKG", "ARKQ", "ARKW", "ARKF", "ARKX",

  // ===== INCOME / DIVIDEND ETFs =====
  "JEPI", "JEPQ", "SCHD", "VYM", "DVY", "NOBL",

  // ===== INTL / THEMATIC ETFs =====
  "ICLN", "TAN", "LIT", "BITO", "BLOK", "FXI", "EWZ", "EWJ", "EWY",
  "EWU", "EWG", "INDA", "MCHI", "KWEB", "ASHR", "RSX", "EZA",

  // ===== MEGA-CAP TECH =====
  "AAPL", "MSFT", "NVDA", "AMZN", "GOOG", "GOOGL", "META", "TSLA",
  "AVGO",

  // ===== TECH / SEMI STOCKS =====
  "AMD", "ADBE", "ORCL", "CSCO", "INTC", "INTU", "TMUS", "TXN",
  "QCOM", "AMAT", "KLAC", "LRCX", "ASML", "TSM", "MRVL", "MU",
  "ARM", "IBM", "ON", "MCHP",

  // ===== SOFTWARE / CLOUD / AI =====
  "CRM", "PANW", "CRWD", "DDOG", "MDB", "SNOW", "NET", "OKTA",
  "ESTC", "PLTR", "SHOP", "TWLO", "FSLY", "WDAY", "DOCU", "BILL",
  "TEAM", "SMCI", "IONQ", "BBAI", "SOUN",

  // ===== FINTECH / PAYMENTS =====
  "PYPL", "COIN", "HOOD", "SOFI", "AFRM", "UPST", "MELI", "MARA",
  "RIOT", "CLSK",

  // ===== MEDIA / STREAMING / GAMING =====
  "NFLX", "DIS", "ROKU", "SPOT", "PINS", "SNAP", "RBLX", "TTWO",
  "NTES", "TME",

  // ===== E-COMM / TRAVEL =====
  "BABA", "PDD", "ABNB", "DASH", "UBER", "LYFT", "BKNG", "EXPE",
  "MAR", "HLT", "MGM", "WYNN", "LVS", "CCL", "NCLH", "RCL",

  // ===== EV / AUTO =====
  "RIVN", "LCID", "NIO", "XPEV", "FSR", "CHPT", "BLNK", "PLUG",
  "FCEL", "BLDP", "NKLA", "MULN",

  // ===== ENERGY =====
  "XOM", "CVX", "COP", "SLB", "OXY", "HAL", "EOG", "PXD", "DVN",
  "VLO", "PSX", "MPC", "KMI", "WMB", "FANG", "MRO", "APA", "BKR",

  // ===== UTILITIES =====
  "NEE", "DUK", "SO", "AEP", "EXC", "XEL", "ETR", "EIX", "SRE",
  "AWK", "WEC", "ES",

  // ===== INDUSTRIALS =====
  "BA", "CAT", "DE", "HON", "LMT", "RTX", "NOC", "MMM", "ETN",
  "ITW", "EMR", "DOV", "PH", "ROK", "FDX", "UPS", "CSX", "NSC",
  "UNP", "LHX",

  // ===== HEALTHCARE =====
  "LLY", "UNH", "JNJ", "MRK", "ABBV", "PFE", "TMO", "DHR", "ABT",
  "BMY", "AMGN", "GILD", "ISRG", "REGN", "VRTX", "MDT", "BSX",
  "SYK", "ZTS", "MRNA", "BNTX", "NVAX", "AZN", "NVO",

  // ===== FINANCIALS =====
  "JPM", "BAC", "WFC", "MS", "USB", "PNC", "TFC", "BLK", "SCHW",
  "AXP", "COF", "AON", "MMC", "PGR", "TRV", "MET", "PRU", "AIG",
  "KKR", "BX",

  // ===== CONSUMER =====
  "WMT", "COST", "TGT", "PG", "KO", "PEP", "MCD", "SBUX", "NKE",
  "TJX", "CMG", "YUM", "MNST", "MDLZ", "GIS", "KMB", "PM", "KHC",
  "HSY", "CPB",

  // ===== MEMES / HIGH VOL =====
  "GME", "AMC", "BB", "BBBY", "CVNA",

  // ===== CHINA =====
  "BIDU", "BILI",

  // ===== SPACE =====
  "SPCX", "RKLB", "ASTS", "LUNR", "RDW",
]);
