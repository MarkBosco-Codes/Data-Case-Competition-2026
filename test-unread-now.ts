import { listUnreadMessages } from './src/lib/zoho.server.js'

async function checkUnread() {
  const res = await listUnreadMessages(50)
  console.log('Unread count now:', res.messages.length)
  console.log('Messages:', res.messages.map(m => ({ id: m.messageId, subject: m.subject, sender: m.sender, fromAddress: m.fromAddress })))
}

checkUnread()
