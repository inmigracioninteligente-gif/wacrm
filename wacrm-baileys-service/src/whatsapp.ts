import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  WASocket,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import QRCode from 'qrcode'
import pino from 'pino'

interface SessionState {
  sock: WASocket | null
  qrImage: string | null
  status: 'qr_pending' | 'connected' | 'disconnected'
}

const sessions = new Map<string, SessionState>()

export async function startSession(accountId: string) {
  const { state, saveCreds } = await useMultiFileAuthState(`./auth/${accountId}`)
  const { version } = await fetchLatestBaileysVersion()
  console.log('Usando version de WhatsApp Web:', version)

  const sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: 'silent' }),
  })

  sessions.set(accountId, { sock, qrImage: null, status: 'qr_pending' })

  sock.ev.on('connection.update', async (update) => {
    const { qr, connection, lastDisconnect } = update
    const session = sessions.get(accountId)!

    if (qr) {
      session.qrImage = await QRCode.toDataURL(qr)
      session.status = 'qr_pending'
    }

    if (connection === 'open') {
      session.status = 'connected'
      session.qrImage = null
      console.log(`Cuenta ${accountId} conectada`)
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      session.status = 'disconnected'
      console.log(`Cuenta ${accountId} desconectada. Codigo: ${statusCode}. Reconectar: ${shouldReconnect}`)
      if (shouldReconnect && statusCode !== 401) startSession(accountId)
    }
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe) return
    console.log(`Mensaje recibido en cuenta ${accountId}:`, JSON.stringify(msg.message))
  })

  return sock
}

export function getSessionStatus(accountId: string) {
  const session = sessions.get(accountId)
  if (!session) return { status: 'not_started', qrImage: null }
  return { status: session.status, qrImage: session.qrImage }
}

export async function sendMessage(accountId: string, to: string, text: string) {
  const session = sessions.get(accountId)
  if (!session?.sock) throw new Error('Sesion no conectada')
  const jid = to.includes('@s.whatsapp.net') ? to : `${to}@s.whatsapp.net`
  await session.sock.sendMessage(jid, { text })
}
