# Diagnóstico reunión WebRTC (navegador + Electron)

Checklist reproducible para cámara, ruido de audio y pantalla compartida.

## Antes de la sesión

1. Servidor: `npm run dev` o `npm run electron:dev`.
2. Electron profesor: `MOJ_ELECTRON_DEVTOOLS=1` opcional.
3. Estudiante: Chrome/Edge en `http://127.0.0.1:3000` (misma máquina o red local).

## Durante la reunión (renderer DevTools)

```javascript
// Snapshot unificado (tras entrar en sala)
typeof getMeetingMediaDiagnostics === "function" && getMeetingMediaDiagnostics()
```

Campos clave: `captureLevel` (`av` | `audio` | `none`), `video`, `sharingScreen`, `screenAudio`, `shareWithAudio`.

### Cámara estudiante

- Barra/banner `#mediaCaptureBanner` visible si `captureLevel !== "av"`.
- `chrome://webrtc-internals` → getUserMedia / outbound video track.
- Permisos del sitio: cámara permitida.

### Ruido con micrófonos cerrados

```javascript
({
  mic: localStream?.getAudioTracks()?.[0]?.enabled,
  screenAudio: screenShareAudioTrack?.enabled,
  shareWithAudio,
  outgoing: typeof getOutgoingAudioTrack === "function" ? getOutgoingAudioTrack()?.label : null,
})
```

- Si `shareWithAudio === true` y hay `screenShareAudioTrack` live, el micrófono UI **no** silencia el audio de sistema.
- Comprobar modo audio: `MeetingAudioPolicy.getAudioMode()`.

### Pantalla compartida en Electron (profesor sharer)

- Tras Compartir → Pantalla: `#roomShell` debe tener clase `room-shell--remote-screen-dominant`.
- `#roomRemoteScreenStage` visible con preview local (etiqueta «Tu pantalla compartida»).
- El emisor **no** recibe `meet:screenShare` por socket (`socket.to` en servidor); la vista previa es local.

## Terminal Electron (main)

- `[electron] screen share IPC registered`
- `[electron] Screen share source selected: …` al elegir fuente

## Regresión socket

```bash
npm run test:screen-share-stop
```
