/**
 * meetingMedia.js — captura local (getUserMedia), errores legibles y diagnóstico.
 */
(function (global) {
  function humanizeGetUserMediaError(err, isElectron) {
    const name = err?.name || '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      if (isElectron) {
        return 'Permiso denegado para cámara o micrófono. En Windows: Configuración → Privacidad → Cámara/Micrófono → permitir Electron.';
      }
      return 'Permiso denegado para cámara o micrófono. Revisa los permisos del navegador para este sitio.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return 'No se encontró cámara o micrófono. Conecta un dispositivo e inténtalo de nuevo.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      if (isElectron) {
        return 'La cámara o el micrófono están en uso (otra app o pestaña). Ciérralas y pulsa «Reiniciar cámara y micrófono».';
      }
      return 'La cámara o el micrófono están en uso por otra aplicación. Ciérrala e inténtalo de nuevo.';
    }
    if (name === 'OverconstrainedError') {
      return 'Ningún dispositivo cumple los requisitos solicitados. Prueba «Reiniciar cámara y micrófono».';
    }
    return err?.message || 'No se pudo acceder a cámara o micrófono.';
  }

  function logGetUserMediaFailure(phase, err, constraints, meta) {
    console.warn('getUserMedia', phase, {
      name: err?.name,
      message: err?.message,
      ...meta,
      constraints,
    });
  }

  /**
   * @param {object} options
   * @param {object} deps
   * @returns {Promise<{ stream: MediaStream, level: 'av' | 'audio' | 'none', mediaError: string }>}
   */
  async function acquireLocalMediaWithFallbacks(options, deps) {
    const allowSilentJoin = options.allowSilentJoin === true;
    const relaxedFirst =
      options.relaxed !== false &&
      (deps.isElectronClient() || !deps.getCaptureEverSucceeded());
    let avConstraints = deps.buildAvConstraints({ relaxed: relaxedFirst });
    let firstErr = null;

    try {
      const stream = await navigator.mediaDevices.getUserMedia(avConstraints);
      deps.setCaptureEverSucceeded(true);
      return { stream, level: 'av', mediaError: '' };
    } catch (e1) {
      firstErr = e1;
      logGetUserMediaFailure('audio+video', e1, avConstraints, deps.getLogMeta?.() || {});
      if (e1?.name === 'OverconstrainedError') {
        try {
          avConstraints = deps.buildAvConstraints({ relaxed: true });
          const stream = await navigator.mediaDevices.getUserMedia(avConstraints);
          deps.setCaptureEverSucceeded(true);
          return {
            stream,
            level: 'av',
            mediaError: humanizeGetUserMediaError(e1, deps.isElectronClient()),
          };
        } catch (eRelaxed) {
          firstErr = eRelaxed;
          logGetUserMediaFailure('audio+video-relaxed', eRelaxed, avConstraints, deps.getLogMeta?.() || {});
        }
      }
    }

    const audioConstraints = deps.buildAudioOnlyConstraints({ relaxed: relaxedFirst });
    try {
      const stream = await navigator.mediaDevices.getUserMedia(audioConstraints);
      deps.setCaptureEverSucceeded(true);
      return {
        stream,
        level: 'audio',
        mediaError: humanizeGetUserMediaError(firstErr, deps.isElectronClient()),
      };
    } catch (e2) {
      logGetUserMediaFailure('audio-only', e2, audioConstraints, deps.getLogMeta?.() || {});
      if (allowSilentJoin) {
        return {
          stream: new MediaStream(),
          level: 'none',
          mediaError: humanizeGetUserMediaError(firstErr || e2, deps.isElectronClient()),
        };
      }
      throw e2;
    }
  }

  /**
   * Snapshot para DevTools / soporte (no incluye PII).
   * @param {object} ctx
   */
  function getMediaCaptureDiagnostics(ctx) {
    const ls = ctx.localStream;
    const vt = ls?.getVideoTracks?.()?.[0];
    const at = ls?.getAudioTracks?.()?.[0];
    return {
      electron: !!ctx.isElectron,
      captureLevel: ctx.lastCaptureLevel || 'unknown',
      video: vt
        ? { readyState: vt.readyState, enabled: vt.enabled, label: vt.label }
        : null,
      audio: at
        ? { readyState: at.readyState, enabled: at.enabled, label: at.label }
        : null,
      sharingScreen: !!ctx.sharingScreen,
      screenAudio: ctx.screenShareAudioTrack
        ? {
            readyState: ctx.screenShareAudioTrack.readyState,
            enabled: ctx.screenShareAudioTrack.enabled,
            label: ctx.screenShareAudioTrack.label,
          }
        : null,
      shareWithAudio: !!ctx.shareWithAudio,
      audioMode: global.MeetingAudioPolicy?.getAudioMode?.() || 'headphones',
      remoteScreenShareUserId: ctx.remoteScreenShareUserId || '',
      peerCount: ctx.peerCount ?? 0,
    };
  }

  const MeetingMedia = {
    humanizeGetUserMediaError,
    logGetUserMediaFailure,
    acquireLocalMediaWithFallbacks,
    getMediaCaptureDiagnostics,
  };

  global.MeetingMedia = MeetingMedia;
})(typeof window !== 'undefined' ? window : global);
