// lib/solana/rifts/types.ts - Types, interfaces, and constants for Rifts Service
import { Connection, PublicKey, Transaction } from '@solana/web3.js';

// ============ PROGRAM IDS ============
export const RIFTS_PROGRAM_ID = new PublicKey(process.env.NEXT_PUBLIC_RIFTS_PROGRAM_ID || '29JgMGWZ28CSF7JLStKFp8xb4BZyf7QitG5CHcfRBYoR'); // ✅ RIFTS PROGRAM V2 - MAINNET (NEW - with name prefix fix)
export const RIFTS_PROGRAM_ID_OLD = new PublicKey('6FEZJKsxbDm5W4Ad4eogNehivRKKGCHJHRnKUSFbLpKt'); // ✅ RIFTS PROGRAM V2 - MAINNET (OLD - before name prefix fix)
export const RIFTS_V1_PROGRAM_ID = new PublicKey(process.env.NEXT_PUBLIC_RIFTS_V1_PROGRAM_ID || '9qomJJ5jMzaKu9JXgMzbA3KEyQ3kqcW7hN3xq3tMEkww'); // ✅ RIFTS PROGRAM V1 - LEGACY

// Meteora DAMM V2 program ID
export const METEORA_DAMM_V2_PROGRAM_ID = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');

// WSOL mint address
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// Specific V1 Rift that needs backward compatibility
export const V1_RIFTS = [
  'CuyPWoNgoLQ8DHkZFK6A8CW65p1ecLqMWfE7AvphNmWL', // V1 rRIFTS rift PDA (token mint: 3X7VGd8dK6obiQUtAVRZhTRpP1sfhLc1JMGtQi4hYi2z shows on DEXScreener)
];

// Helper function to determine which program ID to use for a given rift
export function getProgramIdForRift(riftAddress: string): PublicKey {
  if (V1_RIFTS.includes(riftAddress)) {
    console.log(`🔄 Using V1 program for rift: ${riftAddress}`);
    return RIFTS_V1_PROGRAM_ID;
  }
  return RIFTS_PROGRAM_ID;
}

// Helper function to determine program version for a given rift
export function getProgramVersionForRift(riftAddress: string): 'v1' | 'v2' {
  return V1_RIFTS.includes(riftAddress) ? 'v1' : 'v2';
}

// Blacklisted rifts that should never be prefetched (broken/problematic rifts)
export const BLACKLISTED_RIFTS = [
  'DHK2razVoP3WfMgeumLaUKf3wtfy9jTBhiFhAaJhZf2',
  'gddfsrLWuigXeA5kqMHognrRvRs1C28tyemuYDiiZR3',
  'Qv393sNS6Ed7qvhbDKXHifS8t3u8pXU4t8XCU9kYD4N',
  '69VsEuRCNFhdH2P2ubSsQ94EgynuSxjF9GNty5grJv2C', // Old rRIFTS rift (wraps deprecated RIFTS token)
  'BhpUPeJm773h4QbZWT4idAcJmjifUdhtRJLr18ZFpQzc', // Blacklisted pool
  '14sWahdd5VX4cqZsQxsV2rEk6fB1qH5o7ujeCQfqc669',
  '4SUAJjj3HodAzNtymwvZUyJyNc1eFWw5UuHZL3toq4kX',
  '5AUUh6NPrKG5k2X76U8bkJixvDdxkkVkmr23cCCCL5Sm',
  'ExvDhH7C5iaSKRfckGJkFVHGP2maWJGfiEyKkms1BJBH',
  '7zSyd7QBpuVkB71f7yNnUyVF91LUQaxJM6Tfotto4U5n',
  'HV58w6gNMuwyf1vgtvmjKebyaXfmwE14br3Xgoq4kunT',
  '21pitCzF7MCYMSTtDbbF7RjrHhXM7NSqo8jLvdr3Axgj',
  'Fvfxfyj4mS4ohwrH88Wr6q1Uesb3MUffxxntokySGwFF',
  '4GjA8zwxog91JDPQzXkzSnQ1w6jfUSsLaJrGHCUomuoj',
  '8afBm6VXTmG98bUrs5iD3dJz7CmZvPn8koMqA3zU5qmA',
  'HxMapD5ABmruZr5b8ifhNUbXe5rJi7mB7T9PsKbs4k72',
  'wM2VZHVx3wjs4sYcYfBegpMxoX2rVtLtcfayBJZswpQ',
  '4eAFTDynCLD9nm3M1ERA4iUwNhaMrSWwrcxJY94rF9rQ',
  '4k3aCUi5d337Ky54GxVjotrc9wCqM7MYva9kEud4f8bN',
  'FeKU1hHjDGKJmsuLae2FjxH3rBV3q5YoRVzKBQbFdnta',
  // Test rifts from production Supabase:
  '145ZaRFPtv8EL5xxGV2TUHjr7M6B6qqheC5m9juvUgk', // rWrappedSOL (test)
  'HQaJvGBBFGjkqrc73XqdH5WGKc4hwaYho5fup5mxQ7zU', // rSOL (test)
  'EBC8nYPNXQyvvVUEjmMq1yLo16obBxiDyFapgRReBEPF', // rTestVanity (test)
  'bhGJ4kxeRJMP7ok8y4TrnZErLC8EmGCW4w4akMbKVFa', // Old rRIFTS with 0% APY
  'B9pTgzGp4pntrMpS87k44jiRta3awCG7N8vA9cHx8aFS', // rRIFT (typo/test)
  '4NpsmxiLnH7b5pbCbfumd8F11Em6VowVMtwSY66TdfQ6', // rSOL (old test)
  'keL36o5UZt8BptBW5Xc3AnzHNKtQ2DRuEQtn2v84Fww', // Old rRIFTS with 0% APY
  'HWpH2dB43KA4MzXn9TivtZNzuySrrsP5ktd1m2doURc3', // Old rRIFTS with 0% APY
  '7b1M355Mru6TjSvjJ1qXqarLtSLBzSmhLnDZsmPqtzd8', // rCHAD (blacklisted)
  'Di1ZQJzQKhAgPN9NuN8qxJoazobQP7JRQeibvpr4VTAs',  // rZYNX (blacklisted)
  '9gu1CBCkmKV7jcgjvGVbv98go2nPdzAvzAH83BrH7Ds3',
  '9nKVABgJpUWXUh7fg7ukGEHLDEpQvYx3mqRdwkuGfh64',
  '25KBckYWMDi7qaNrfUvM9KiAByTKxeticK5t6Yr11pB1',
  'Bd4CBRpv2VAfkmqi8MPkHXNqKsB2k6AXftVryW4jujQJ',
  '7HzJ8Q7nJ5beUxhz65nsngKBNtEwrTND15DZ1A8BcN2G',
  'DnjFCQZBgrLhih9nvcqsdM1stD4xLS9vtNDkgspLUFBQ',
  'FcrNqY29M1copm2z9Jhxat7A2aEyeuZcb8yRFZaduSrj',
  'FpYj2KDNyWqe52Pp4EsmqcxGHJXxdEbcASqmtThftTAH',
  'ExegwPnuBtDReytawj2CFvFWpLGMAxoL8K6r1mrmphgy',
  '25YabfhwH5thHpHsfLW3o5GBd95Pv2i6m3ZhaXqjFAEL',
  // Spam token mints (added 2025-12-08)
  'HoLby3UCqiDSGBGTLWprgDrUsrcGmipsBk5r6cy19S7P',
  'CobGpbRDaMkCDBCBd2bLy8ygF32wc5rHuNdzRgiGCaaQ',
  '6GySR9xuB5b54meXbZm84SbyPkc4BfAbVQbM51jDpxF6',
  'DsgnXQWbfW569qGmk3j5ubW7qc4tqVSdrmXYtwCYkNoq',
  '2GYxm3TSqpQBVevNPpt54Gir5xjdJdHh6fHF9Z6WFGDA',
  'F7VDxdnNpUnZQe4MD82xyS9MtySg6kdQEPZWv2VkVm3',
  'AiabCY6nfmctX1DSw5PhVqMrPpYzr4Afs44SmhzmM3UZ',
  '3JMTuphaaUb3ktE9WtCGkKahJA2iFBH76e6G44dqT7Q4',
  '98ZBtBNJMW4HGmB3NTVqxZpec7hCxwZ4s4bJHCDsrW6y',
  'BmcjMmtP42Fq6XSVm2iHTTRGeYaTW8KSvxXYT9jCrpf8',
  'F9geTLNMzvLkcaqeBJvN75QudAMMNtQigghfYnUWvTDs',
  '9f1EqSXfLX5FFfA8v1dnKDpsnMb8N9J6ZdjM7RKzanHN',
  'Hv7R8UC9GnzxfaYer1Cj9JgfgymEDyD3qTWVcxJgDWQA',
  '4CCpFeEh6bmMWT1xtGvg4PZrwFEck4bPE9eCP29C3BAc',
  'CqKGpBRXhsuH8gsprRpHUQQVrapW2EVWKgSwzwi4qphH',
  'DxyWsm5Ut9mMtpdnFkBEUH8zfv4QTDtn9P6xoLVHGNvG',
  'GXu6DhgpCXjTxAaDQ8F8APPUeCbMXxGGu6Uq2UrMdeB3',
  'GBdAb3T13VfsCrzgNCmTWysh1zyFBcYQc3J92yePrEqe',
  '4x7BAm6oM91m82c2muA5ptsZNmTaNzhqGZzHa3kondxa',
  // Monorifts (prefixType=1) - blacklisted 2025-12-10
  '6SJVNjGZkiVerDkmGMdkGDg3RrVuN9T6SDX7BKaGeBkK', // rRIFTS (monorift)
  'CrjmBUb4dDBu1tsPf3D4rNAPayUMPek3iRUER8aetESJ', // rRIFTS (monorift)
  'Z9XkkdGK1egGkbTjUGhz9D6utjTmzDCUNRgDaipcowA', // rRIFTS (monorift)
  '4xZtA5Uis9dsxnBcqAtbRL2V9DQ5KT2WwBEuYaqZhyHH', // rRIFTS (monorift)
  '7C7uYYaWUCY4XdVksPiewYwsc84PhWAF8ubFvMC1YSuf', // rRIFTS (monorift)
  'ACj8epqQb6pWfaMunB6GndQ5iHvzXARuDy3EU44aAVZp', // rRIFTS (monorift)
  '7zwRgVsGGQHFwiyuS5jpzNo8jSdp7fu73zWWmApqnKk9', // rRIFTS (monorift)
  '6fugfN68qqmyG96EtyHJESDwCb8YznNgAyQ5J78MtycS', // rRIFTS (monorift)
  'EE1hRhDAvcW6tKvTjqcKRT3WAA8KftNF5YqNUXhJrDXT', // rRIFTS (monorift)
  '2kGBFM24NQCx7GLeg8xChccvGaZXn5tQdAYTRtpzf8SX', // rRIFTS (monorift)
  'FeXBmr3SeJXk5PRKgu9uCnUuzQVLp7g7R22iaLxbFHf6', // rRIFTS (monorift)
  'Cxz1TP2kSc9yyDYXxXuafbt6Cd6T9jxWbGk8neLu2DB6', // rRIFTS (monorift)
  '1CN5K38bxG2QREspvgbKnkASSdjCrPBVZxHFRatNLTA', // rRIFTS (monorift)
  'Cqg1okDXENuzUh8wD1EwZNgGXPo6LcAhFkxGSQoxM94E', // rRIFTS (monorift)
  'FznXqLWePcnaWpMumuTLTUVCHnJAvjLbdZgzd3YDHKLY', // rRIFTS (monorift)
  '3RcZ13aPcNR1o6oE7ARkR5hSadDikf34Lj76PPDjiQUq', // rRIFTS (monorift)
  'HkxcGvQp5WPhDYxJQutFrtS5avbB2UtLqPqtCckn7Evx', // rRIFTS (monorift)
  '2Rt2xbVas5muuWxdqBgzBfXx9USBQ9yjAnrbyVZB7Dnc', // rRIFTS (monorift)
  '3L1KUmAxjeYuknDmXqn2Qpb4DwiuLaNyETEPKhwV91UW', // rRIFTS (monorift)
  '5se5K1gSKDLWURCNDb5kK8FGQmV4grRXYeorNRu7pe6J', // rRIFTS (monorift)
  '5vL3WU9cUxQWmmxKiYPwNc9reJosoNNEbPziTN5bTvuq', // rRIFTS (monorift)
  '66TdqMSZ9YyLoETySsqJ22qiTSNpYL5AsJo3LVAn6BnH', // rRIFTS (monorift)
  '67weGvFYFnpYxz4oLEQ7jCt5dVjJZME2xvPU4VP23E2w', // rRIFTS (monorift)
  '6E7rc31mYjaFf53TZbt4eZpLwoF3UpF27HeVBSE9szCM', // rRIFTS (monorift)
  '7AVPGVBusoRYbwTkqyucQpAsYNUhAeijsDpo8WcBEJZH', // rRIFTS (monorift)
  '7p4HtrEDtDPLH216wE3dVGph9UcH4oUkEzRUC6SCnwpC', // rRIFTS (monorift)
  '8S1Aww6kdyF5eUFn6uvhJpgkwXHAc3RHxi1cCuLemVhq', // rRIFTS (monorift)
  '9xgCoWdvL3UDtfi2qBtGaXf8WUnmrF1KgiruKTqu9LBY', // rRIFTS (monorift)
  'AWkKTGkeD3fUA3cBCxUzKdsP5nE5pydrsWh6yTAFryns', // rRIFTS (monorift)
  'AcAyW3M1RXkgmZvWiXNbAfLuynQPEjnkCEEuZ6p8eJ97', // rRIFTS (monorift)
  'AevcvqszvjMQEdv755YV7oNsGq6Rd5bHcXU8p5mLZfHJ', // rRIFTS (monorift)
  'BBpxuCVEfyokB2NFHCiiBWYfQDcY4oM1AgxbiyQwkgbY', // rRIFTS (monorift)
  'E56JXdtGNc7gvb9mJB1dF5JMAJkfxcqiodMWfysTuHAZ', // rRIFTS (monorift)
  'ER4L7Ff811Ta697zhgFWF24BNu2zmVMT8p5S28bbhj5r', // rRIFTS (monorift)
  'F2UFAox1jRUjtuf2Kc5ctrV33WSW8Gu6pi3zn99JSXVb', // rRIFTS (monorift)
  'FWM87zRNHm1vktiXeqY1Zchj8ydR6fDiqT5SRh4BCWtg', // rRIFTS (monorift)
  'FiYVuPseVh9mwG9WA1ToFynMRA3WDoQrrzvXjt6j3bK3', // rRIFTS (monorift)
  // Blacklisted 2025-12-12
  '2vB6JsJQRr3Yzx34vDX1deThQkfyMQzXNikNn82wGx7A',
  '6jMoNaxKJ9q5hYfoTNVnophuBrqodcCZmCQDAcHH9Cn3',
  '78CN3T5u3SMapASMXLpNjrHpLdb9yAqVPibELyp4vbar',
  'D2jbTwfLZbo7MDXpqMwsCVAPd5PbF2sW2iF25qVGHQXS',
  'Bd9G1MwWkZpWRZXtRMSdEf84s6FJ31buRtLM4D6SJdHj',
  'EBV6e3Stq9ZGtRgoV6R3y5pw68Vh4SA5456ZmBHK1PQC',
  '6nD5PsqPaRVH3EZ7hcdrVWGZXzWMsmAsxZwt1HLmQL5h',
  'ESuhYUYhXgVvU49f5nauDHCSd7CYMYZdEZen9WwZEycr',
  '8q5nAe1X7sMCgYyon25AV1bjo5MqkRBe1zA4ZQ8fCxZB',
  '7439zkryQTQGuhVb246C4rKhrmxwLn4eCHrWhN6JN4bg',
  '9LLGop66wiCDSDVgNtwPNaUPQy3A75fPsyPp9ZVqaryW',
  'B4DH737bC7orabLYr3BPok7YXE1DhTANoi86ZckB9rwD',
  'FnjpNifk2w9ZrcJAcC8GjA7MMPB9p1DjKrdmyioWEmsf',
  '75z7UfXKL7fd68YsEMCxke9JGkLKzUTexFhopg7PefWC',
  'ExzDgXVDA2jXEUP1HEiZn9vBm2ZCESke5ysJHqvTd2dA',
  'AhxUn7mHcceuCeAFq5Ni7RMYdxUGUunPqYfeqrpWE5Ri',
  'H66sFrW8W5f3C1vnGW2mRwLt6uUNowYHi59MApdByF65',
  'H9KTDXRwmpda1bq2KHWPGrC2321VNW7oZGFz9QSaZRvg',
  '9NxGoDoXznkDZcRjE7ZipxMZKx827D1qfh5FMxRNbeM4',
  'DFjr24Gbqz3y1PcSMvYLhBvfpMyENkUfmwUJ5Z83J3Fb',
  'BrmahaEPx9usFiAvSgpwqt6UZ6tNXYUTZTjEKgeyhgtj',
  'qcARQMDneMWi4XYdXrYYKMUhtA6vpmY3NZFNRtR2dRU',
  'B6ygHXjGcji5S7Hg8dnp9Xb9X3KyufGyCwx1pCGSeejW',
  '26ux2Yh5sq85KLX6c8Mc1XtrBQXoxBmUew6XM31u2PTY',
  'EHRTEFmuS1p9U23D7kNoP9EzENZBDudqC8amK7UJZhPe',
  '6TPAWdVVdNZbq7Jxm9cgmRt64iUCApKq6DJ81KbXuKVX',
  'ETikwhqtKU4RXKm2CXrULC7KajJEr5uDzmigCiizn7Dr',
  'JA44SaejX6HDMewDYGvZehUrNNi9EBBdy7bzQnUYxpM8',
  '4EtjPxr9zJURZXdQwfSBJhs3ds3R4Z74gHYnyiAyLbwM',
  '4bYiRB13DbGhXd3WGgLBGEdKaed6akMdJExFM57Zwx81',
  // Blacklisted 2025-12-13
  'BKTS2B3Tx3UixVTv5yAenX1NJTTuUtZpuFXrpuTTq2tY',
  '9Ah3JZcBVeo7ZobCMDoV7tNTy9N1x5Kik8c2gt98RtvH',
  '9vtNAdkaP51jesuLhsHqq4hJhsK6QKmNxDu5rdbSdD2n',
  '9ZhF74Hjs8WbUFwMxyEXyMSN2WW6R35CLuGTm5zv3Cyh',
  '14GJmMaJTt2b7QgRRp7ZUSgexy5D9Usbxpzq3noZZMNk',
  '8Lsu3WviXXSM1eUQMAF22dRcT5hQBhAiUFEoCAdzGxJ6',
  '6KaDKbgQ6Wt58y3JufQ2B6zqgx5ugkSaASiB4CB6Qac7',
  'gmdBqrFWShG3mjejVL43PgCJQfV4vfTQ2XefTkbKkgL',
  'FVuq2BsrHwSDUABRpDQKm2jVjPQF7QRRseoxGtTQ2ScE',
  'B8XKRY4bwDUpkma2R5dY5sbo3Pj7bE1NpCafvNy3G3Sx',
  'DHLMxGxUfKLzungHxiNtV1mzCnU7ngAbqKYCeY86nwGc',
  'A2Xh54ctkVWdxYJE2kuyiWc3Zr4ygyPtvh7bC2V4Pu7u',
  '6bnG2QFRuPKMZ5D7LL4tFLFEjtuPP5fd7NH354ANQkTu',
  '6rZRW9SLAT1qxwehcyr6jogToRUdXMABr6qfSRHdAnAR',
  'UPMoGYeAQSc6AAffQQqmJzP8D5yDwiQh8nNdjvTY5s4',
  '9ogo318NeUqDtp1CSy1x1pbQn1kqqLps3oErrWmGPJER',
  '73xrCeEp6inf2aLP7JnLhEcZeezTEgS3jB776kPaegqa',
  '6uBNoBe8SH5F8m4WujrHrCQvndgxgiXThaRS2gs4T81f',
  // Blacklisted 2025-12-14 - duplicate rSOL rifts with inflated volume
  'ELF8r8L4rcwWArG4s7n3zzFLKwh6BMrCBDGZXMBwLk8D',
  'BvNu92KVPZ38khZA9qerpa9GcwiRYkhcQbVnbH733Ve9',
  '8yPnbjBKJBQWPZetpLqnuuk2PsbSV5FyH7XoWpAjHAAC',
  '6EEsSF9ihGnAZMGciwTqmtfGNKtmDCDreFGndZhpjowU',
  '5z7mQuSScTK8V8Jwh6PrWfdKouhNtEUGbsBs8v6EyZt2',
  '35uFqoKii9VG8d7N2vZLdA4QsTCxQSrXsyGjxmiZv75A',
  '31SSe8yYucHEnC6v8Nr3GYXnNzCeub2Nxxc5gY2hXy1B',
  // Blacklisted 2025-12-14 - monorifts with inflated DEX volume
  '61b97AVdpsxjtJ2sgaVg55Zey9mqRYX7mAQE49dE7g8D',
  'DZBp1P4YACoBw6Zch9DAhkcQ6oYaxp6pHyshjC6XGDg5',
  '5EiEyz79yCLn126XBX9kkgutrBeTcGQuDdvqGdCsPAqf',
  'GVjpiVHzVcJ2vBXZxVs7N3JaXZBWYLyMf58oGL29UHam',
  'CPCL3ZGKB34JmZMZKAFXdpzzuVtxS7VKvCwLKpJpKpun',
  'Fywfd8ehBUGqY1Zp9RQg3MH74cVd6xcerwJ5zpbyNkVu',
  '5w2wfwg7Ai7wcGTAeRpCRdyhUED2n1ieHSCeHkSuviQ6',
  '5tULRSXFucTsr8YRseGdCaiL6DpjwVwxxuPXCpqh7PSE',
  '8zChjEwBnSafVQENjrK9mkAnv8WDkUPAgmApeo19SvFm',
  '9Jfh3dhQQYYm3NXYFeRSJyznwYpKUEVEpu1apeTwjGUj',
  'F4G6eC7ZPEQT9jPc2wcyi51ESJKoZzsgrcoTQV8FvjWa',
  'LBKpC8TLmvpcJLbQSuQTu9bptfEA8taiYTBtUKZ9Y2u',
  'oF74pcaG54FJ1dK4xvDYAxvX99pVbwrVwUbtkdqk5YM',
  'E7TzSsuZGXxGMaxYgp3KB7JxSLYyCM8Kw7cibjLyN27i',
  '4Ex6m9pH7aBweQ8tJz4Wb8M2tnGLMBjtzBKcDDabJQfK',
];

// ============ INTERFACES ============

export interface WalletAdapter {
  publicKey: PublicKey | null;
  sendTransaction: (transaction: Transaction, connection: Connection, options?: any) => Promise<string>;
  signTransaction?: (transaction: Transaction) => Promise<Transaction>; // Optional - not all wallets support this
}

export interface DecodedRiftData {
  name?: string;
  creator: string;
  underlyingMint: string;
  riftMint: string;
  vault: string;
  treasuryWallet?: string;
  partnerWallet?: string;
  burnFee: number;
  partnerFee: number;
  wrapFeeBps?: number; // Wrap fee in basis points
  unwrapFeeBps?: number; // Unwrap fee in basis points
  partnerFeeBps?: number; // Partner fee in basis points
  totalWrapped: bigint;
  totalBurned: bigint;
  backingRatio: bigint;
  lastRebalance: bigint;
  createdAt: bigint;
  oracleUpdateInterval: bigint;
  maxRebalanceInterval: bigint;
  arbitrageThresholdBps: number;
  lastOracleUpdate: bigint;
  totalVolume24h: bigint;
  priceDeviation: bigint;
  arbitrageOpportunityBps: number;
  rebalanceCount: number;
  totalFeesCollected: bigint;
  riftsTokensDistributed: bigint;
  riftsTokensBurned: bigint;
}

export interface ProductionRiftData {
  id: string;
  symbol: string;
  underlying: string;
  strategy: string;
  apy: number;
  tvl: number;
  volume24h: number;
  risk: 'Very Low' | 'Low' | 'Medium' | 'High';
  backingRatio: number;
  burnFee: number;
  partnerFee: number;
  wrapFeeBps?: number; // Wrap fee in basis points (e.g., 30 = 0.3%)
  unwrapFeeBps?: number; // Unwrap fee in basis points (e.g., 30 = 0.3%)
  partnerFeeBps?: number; // Partner fee in basis points
  transferFeeBps?: number; // Token-2022 transfer fee in basis points (e.g., 70-100 = 0.7%-1.0%)
  programVersion?: 'v1' | 'v2'; // Program version: v1 (legacy) or v2 (current)
  programId?: string; // Program ID as base58 string
  creator: string;
  treasuryWallet?: string;
  partnerWallet?: string;
  underlyingMint: string;
  riftMint: string;
  vault: string;
  totalWrapped: string;
  totalBurned: string;
  createdAt: Date;
  lastRebalance: Date;
  arbitrageOpportunity: number;
  oracleCountdown: number;
  nextRebalance: number;
  performance: number[];
  realVaultBalance: number;
  realRiftSupply: number;
  realBackingRatio: number;
  priceDeviation: number;
  volumeTriggerActive: boolean;
  participants: number;
  oracleStatus: 'active' | 'degraded' | 'inactive';
  hasMeteoraPool?: boolean;
  meteoraPoolTVL?: number;
  liquidityPool?: string; // Primary Meteora pool address for trading (backward compatibility)
  meteoraPool?: string; // Alias for liquidityPool for backward compatibility
  meteoraPools?: string[]; // Array of ALL Meteora pool addresses for this rift
  positionNftMint?: string; // Position NFT mint address for Meteora pool
  meteoraPoolType?: 'SOL' | 'RIFTS' | 'USD1'; // Type of the primary pool (SOL/rRIFTS, RIFTS/rRIFTS, or USD1/rRIFTS)
  solPool?: string; // SOL/rRIFTS pool address
  riftsPool?: string; // RIFTS/rRIFTS pool address
  usd1Pool?: string; // USD1/rRIFTS pool address
  name?: string;
  address?: string;
  image?: string;
  liquidity?: number;
  price?: number;
  change24h?: number;
  isActive?: boolean;
  lastArbitrageCheck?: Date;
  volume?: number;
  holdersCount?: number;
  riftsCount?: number;
  riftTokenPrice?: number;
  underlyingTokenPrice?: number;
  totalSupply?: number;
  circulatingSupply?: number;
  burnAmount?: number;
  marketCap?: number;
  isLoading?: boolean;
  riftMintPubkey?: string;
  // Pool type for monorifts: 'dlmm' or 'dammv2' (single-sided)
  poolType?: 'dlmm' | 'dammv2' | 'cpamm';
  // Prefix type: 0 = regular rift (r prefix), 1 = monorift (m prefix)
  prefixType?: 0 | 1;
}

// ============ SERVICE CONTEXT INTERFACE ============
// This interface defines all the shared state that module functions need access to
export interface ServiceContext {
  // Core dependencies
  connection: Connection;
  wallet: WalletAdapter | null;

  // Volume tracking
  volumeCallbacks: ((riftId: string, volume: number) => void)[];
  volumeTracker: { [riftId: string]: Array<{volume: number, timestamp: number, participant?: string}> };
  participantTracker: { [riftId: string]: Set<string> };

  // Caches
  mintInfoCache: { [mintAddress: string]: { decimals: number, timestamp: number } };
  riftsCache: ProductionRiftData[];
  lastCacheUpdate: number;

  // State flags
  isLoadingRifts: boolean;
  isWrapInProgress: boolean;
  isProcessingQueue: boolean;

  // RPC management
  lastRpcCall: number;
  rpcCallQueue: Array<{ resolve: (value: unknown) => void; reject: (error: unknown) => void; call: () => Promise<unknown> }>;

  // Intervals
  priceUpdateInterval: ReturnType<typeof setInterval> | null;
}

// Helper type for methods that need the context
export type ContextMethod<T extends (...args: any[]) => any> = (ctx: ServiceContext, ...args: Parameters<T>) => ReturnType<T>;

// Vanity address pool (static, shared across instances)
export interface VanityPoolState {
  pool: Array<{ keypair: any; address: string }>;
  isGenerating: boolean;
  targetSize: number;
  refillThreshold: number;
}

// ============ SERVICE STATE (for backward compatibility) ============
export interface RiftsServiceState {
  riftsCache: ProductionRiftData[];
  lastCacheUpdate: number;
  isLoadingRifts: boolean;
  isWrapInProgress: boolean;
}

// ============ CONSTANTS ============
export const MINT_CACHE_TTL = 60 * 60 * 1000; // 1 hour cache
export const CACHE_DURATION_MS = 30000; // Cache for 30 seconds
export const MIN_RPC_INTERVAL = 1000; // 1 second between RPC calls
