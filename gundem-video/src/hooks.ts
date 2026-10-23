// Kanca kalıpları (prompts/kanca.md "tur"; scripts/wa_video.py HOOK_TYPES aynı liste; kullanıcı isteği, 23 Ekim: bilgilendirme/benzer
// videolar için profesyonel kanca taktiği + trend ses efektleri). Her kalıbın kanca sesi (public/sfx/kanca_*.wav, scripts/make_sfx.py) ve
// kancada beliren damgası (Hook.tsx; boş ise damga yok: rakamlı başlık zaten sarı kutuda, ortadan başlamada damga anlatıyı bozar).
export const HOOK_SOUNDS: Record<string, string> = {
  soru: "sfx/kanca_soru.wav", ters_kose: "sfx/kanca_vinil.wav", rakam: "sfx/kanca_tik.wav", hitap: "sfx/kanca_dur.wav",
  acik_dongu: "sfx/kanca_darbe.wav", yanlis_bilinen: "sfx/kanca_glitch.wav", kiyas: "sfx/kanca_darbe.wav", ortadan: "sfx/kanca_darbe.wav",
};
export const HOOK_STAMPS: Record<string, string> = {
  soru: "?", ters_kose: "!", rakam: "", hitap: "DUR", acik_dongu: "SONA KADAR", yanlis_bilinen: "YANLIŞ", kiyas: "VS", ortadan: "",
};
export const hookSound = (type?: string | null) => (type && HOOK_SOUNDS[type]) || null;
export const hookStamp = (type?: string | null) => (type && HOOK_STAMPS[type]) || null;
