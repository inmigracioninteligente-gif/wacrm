import express from 'express'
import cors from 'cors'
import { startSession, getSessionStatus, sendMessage } from './whatsapp'

const app = express()
app.use(cors())
app.use(express.json())

app.post('/sessions/:accountId/start', async (req, res) => {
  const { accountId } = req.params
  await startSession(accountId)
  res.json({ ok: true, message: 'Sesion iniciada, consulta /status para el QR' })
})

app.get('/sessions/:accountId/status', (req, res) => {
  const { accountId } = req.params
  res.json(getSessionStatus(accountId))
})

app.post('/sessions/:accountId/send', async (req, res) => {
  const { accountId } = req.params
  const { to, text } = req.body
  try {
    await sendMessage(accountId, to, text)
    res.json({ ok: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`Baileys service corriendo en puerto ${PORT}`))
