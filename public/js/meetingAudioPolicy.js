/**
 * meetingAudioPolicy.js — restricciones de audio para reunión (AEC, modo auriculares/altavoces).
 */
(function (global) {
  const LS_AUDIO_MODE = 'moj_meeting_audio_mode';

  /** @returns {'headphones' | 'speakers'} */
  function getAudioMode() {
    try {
      const m = global.localStorage?.getItem(LS_AUDIO_MODE);
      if (m === 'speakers') return 'speakers';
    } catch (_) {}
    return 'headphones';
  }

  /** @param {'headphones' | 'speakers'} mode */
  function setAudioMode(mode) {
    try {
      global.localStorage?.setItem(LS_AUDIO_MODE, mode === 'speakers' ? 'speakers' : 'headphones');
    } catch (_) {}
  }

  /**
   * @param {{ isElectron?: boolean }} ctx
   * @returns {{ echoCancellation: boolean, noiseSuppression: boolean, autoGainControl: boolean }}
   */
  function getAudioProcessingConstraints(ctx = {}) {
    const mode = getAudioMode();
    if (mode === 'headphones') {
      return {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
      };
    }
    if (mode === 'speakers' && !ctx.isElectron) {
      return {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      };
    }
    return {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    };
  }

  function describeAudioMode() {
    return getAudioMode() === 'speakers'
      ? 'Altavoces (cancelación de eco activa)'
      : 'Auriculares (recomendado)';
  }

  const MeetingAudioPolicy = {
    getAudioMode,
    setAudioMode,
    getAudioProcessingConstraints,
    describeAudioMode,
  };

  global.MeetingAudioPolicy = MeetingAudioPolicy;
})(typeof window !== 'undefined' ? window : global);
