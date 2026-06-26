import { FastifyInstance } from 'fastify'
import { setBroadcaster, Broadcaster } from '../main/services/broadcaster'

export async function registerWs(app: FastifyInstance): Promise<void> {
  // Auth-gated upgrade: requireAuth runs as preValidation (before the socket opens);
  // an unauthenticated/revoked request is rejected 401 and never upgraded.
  app.get('/ws', { websocket: true, preValidation: [app.requireAuth] }, (socket) => {
    // No inbound protocol yet (server→client push only). Keep the socket open;
    // attach a no-op message handler so backpressure does not pause it.
    socket.on('message', () => { /* reserved for future client→server messages */ })
  })

  const wsBroadcaster: Broadcaster = {
    broadcast(channel, payload) {
      const data = JSON.stringify({ channel, payload })
      for (const client of app.websocketServer.clients) {
        if (client.readyState === 1 /* OPEN */) client.send(data)
      }
    }
  }
  setBroadcaster(wsBroadcaster)
  app.addHook('onClose', async () => { setBroadcaster(null) })
}
