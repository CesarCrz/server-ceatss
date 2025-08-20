const express = require('express');
const session = require('express-session');
const path = require('path');
const http = require('http');
const fs = require('fs');
const socketIo = require('socket.io');
const { error } = require('console');
const app = express();
const server = http.createServer(app)
const io = socketIo(server)
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
const doc = require('pdfkit');
const puppeteer = require('puppeteer');
const handlebars = require('handlebars');
const PORT = process.env.PORT || 3000;

function getPedidosFile(restaurante) {
  const name = (restaurante || 'Soru').toLowerCase();
  return path.join(__dirname, `pedidos_${name}.json`);
}

function cargarPedidos(restaurante) {
  const file = getPedidosFile(restaurante);
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf-8');
  return JSON.parse(raw);
}

function guardarPedidos(pedidos, restaurante) {
  const file = getPedidosFile(restaurante);
  fs.writeFileSync(file, JSON.stringify(pedidos, null, 2), 'utf-8');
}

// Carpeta frontend raíz y src
const FRONTEND_ROOT = path.join(__dirname, '..', '..', 'frontend');
const FRONTEND_SRC = path.join(FRONTEND_ROOT, 'src');

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'soru-secret-key',
  resave: false,
  saveUninitialized: false
}));

// Servir archivos estáticos desde frontend/src
app.use('/CSS', express.static(path.join(FRONTEND_SRC, 'CSS')));
app.use('/JS', express.static(path.join(FRONTEND_SRC, 'JS')));
app.use('/Audio', express.static(path.join(FRONTEND_SRC, 'Audio')));
app.use('/Img', express.static(path.join(FRONTEND_SRC, 'Img')));

// Para servir el index.html directamente
app.get('/', (req, res) => {
  res.sendFile(path.join(FRONTEND_ROOT, 'index.html'));
});
app.get('/main', (req, res) => {
  res.sendFile(path.join(FRONTEND_SRC, 'pages', 'main.html'));
});
app.get('/ticket', (req, res) => {
  res.sendFile(path.join(FRONTEND_SRC, 'pages', 'ticket.html'));
});
app.get('/main/pedidos/:sucursal', (req, res) => {
  res.sendFile(path.join(FRONTEND_SRC, 'pages', 'main.html'));
});

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const WEBHOOK_URL = 'https://webhook.site/7b1378dd-eb7e-4ed8-a737-26653fc2dbe6';
const API_URL = 'https://bot.sushisoru.com.mx/v1/messages';

// Cambios aquí: endpoint para cambiar estado y enviar webhook simulando WhatsApp
app.post('/api/pedidos/:codigo/estado', async (req, res) => {
  const { codigo } = req.params;
  const { estado } = req.body;

  if (!estado) {
    return res.status(400).json({error: 'Falto el campo de estado'});
  }

  let pedidos = cargarPedidos();
  const idx = pedidos.findIndex(p => p.codigo === codigo || p.orderId === codigo);

  if (idx === -1) {
    return res.status(404).json({error: 'Pedido no encontrado'});
  }

  // Detectar el cambio de estado (para mensajes tipo WhatsApp)
  const pedido = pedidos[idx];
  const estadoAnterior = (pedido.estado || '').toLowerCase();
  const nuevoEstado = (estado || '').toLowerCase();
  pedidos[idx].estado = estado;
  guardarPedidos(pedidos);

  io.emit('update_order', pedidos[idx]);

  let DELIVER_REST = '';
  if (pedido.deliverOrRest === 'domicilio') {
    DELIVER_REST = `y será enviado al domicilio ${pedido.address}`;
  } else if (pedido.deliverOrRest === 'entregar') {
    DELIVER_REST = `para recoger en la sucursal ${pedido.sucursal}`;
  }

  // Mensajes simulados de WhatsApp por estado
  let msg = null;
  if (estadoAnterior === 'pendiente' && nuevoEstado === 'en preparacion') {
    msg = `📋 *Pedido ${pedido.codigo}*\n ¡Ya estamos en marcha! Preparamos tu pedido con el espíritu Soru: fresco, creativo y a tu gusto. Disfruta pronto de algo elaborado especialmente para ti坠 �🍣`;
  }
  else if (estadoAnterior === 'en preparacion' && nuevoEstado === 'listo') {
    msg = `✅ *Pedido esperando al repartidor*\n Tu pedido ya fue preparado con nuestro toque único de Soru, en un momento más llegará nuestro repartidor, sigue atento!!\n\n Agradecemos tu paciencia y preferencia`;
  }
  else if (estadoAnterior === ''){ // listo -> liberado desaparece
    msg = `🛵 *Tu pedido va en camino*\nNuestro repartidor ya va rumbo a ti con tu platillo recién preparado 🥢🍜\n¡Gracias por elegir Soru! En unos minutos estarás disfrutando de tu comida como se debe ✨`
  }

  // Enviar webhook si corresponde
  if (msg) {
    try {
      //ENVIO AL WEBHOOK PASO 1
      await fetch(API_URL, {
        method: 'POST',
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          codigoPedido: pedido.codigo,
          nombre: pedido.nombre,
          estadoAnterior,
          nuevoEstado,
          number: pedido.numero,
          message: msg,
          timestamp: new Date().toISOString()
        })
      });
      console.log('enviado al api')
    } catch (e) {
      console.error("Error enviando webhook:", e);
      // Puedes ignorar el error o retornarlo si lo deseas
    }
  }

  res.json({ success: true, pedido: pedidos[idx] });
});

app.post('/api/pedidos/:sucursal', (req, res) => {
  const { sucursal } = req.params;
  const pedido = req.body;

  // Usa el campo restaurante que llega en el pedido
  const restaurante = (pedido.restaurante || 'Soru').toString();

  pedido.sucursal = pedido.sucursal || sucursal;
  pedido.restaurante = restaurante;
  pedido.codigo = pedido.codigo || pedido.orderId;

  // Normaliza el pedido para que siempre tenga un array en pedido.pedido
  if (typeof pedido.productDetails === 'string') {
    try {
      pedido.pedido = JSON.parse(pedido.productDetails);
    } catch (e) {
      pedido.pedido = [];
    }
  } else if (Array.isArray(pedido.productDetails)) {
    pedido.pedido = pedido.productDetails;
  } else if (typeof pedido.pedido === 'string') {
    try {
      pedido.pedido = JSON.parse(pedido.pedido);
    } catch (e) {
      pedido.pedido = [];
    }
  } else if (Array.isArray(pedido.pedido)) {
    // Ya está bien
  } else {
    pedido.pedido = [];
  }

  // Cargar y guardar en el archivo correcto, evita duplicados por codigo
  let pedidos = cargarPedidos(restaurante);
  const yaExiste = pedidos.some(p => p.codigo === pedido.codigo);
  if (!yaExiste) {
    pedidos.push(pedido);
    guardarPedidos(pedidos, restaurante);
  }

  io.emit('new_order', pedido);

  res.sendStatus(201);
});

app.get('/api/pedidos/:codigo', (req, res) => {
  // IMPORTANTE: busca en todos los archivos
  const files = fs.readdirSync(__dirname).filter(f => f.startsWith('pedidos_') && f.endsWith('.json'));
  for (const file of files) {
    const pedidos = JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf-8'));
    const pedido = pedidos.find(p => p.codigo === req.params.codigo || p.orderId === req.params.codigo);
    if (pedido) return res.json(pedido);
  }
  res.status(404).json({error: 'Pedido no encontrado'});
});

app.get('/api/obtenerPedidos', async (req, res) => {
  try {
    const sucursal = req.query.sucursal || 'ALL';

    const url = `https://script.google.com/macros/s/AKfycbzhwNTB1cK11Y3Wm7uiuVrzNmu1HD1IlDTPlAJ37oUDgPIabCWbZqMZr-86mnUDK_JPBA/exec?action=getPedidos&sucursal=${sucursal}`;

    const response = await fetch(url);
    const data = await response.json();

    res.json(data);
  } catch (err) {
    console.log("Error al obtener pedidos:", err);
    res.status(500).json({ error: 'Error al obtener pedidos.' });
  }
});

app.delete('/api/pedidos/:codigo', async (req, res) => {
  const codigo = req.params.codigo;
  let pedidos = cargarPedidos();

  const idx = pedidos.findIndex(p => p.codigo === codigo || p.orderId === codigo);
  if (idx === -1) {
    return res.status(404).json({ success: false, error: 'Pedido no encontrado' });
  }

  // 1. Guarda el pedido a eliminar para usar sus datos
  const eliminado = pedidos[idx];

  // 2. ENVÍA EL MENSAJE WHATSAPP ANTES DE BORRAR
  try {
    // Solo si el pedido estaba en estado "listo" y ahora será "liberado"
    const estadoAnterior = (eliminado.estado || '').toLowerCase();
    if (estadoAnterior === 'listo') {
      // Mensaje de liberado
      const msg = `🛵 *Tu pedido va en camino*\nNuestro repartidor ya va rumbo a ti con tu platillo recién preparado 🥢🍜\n¡Gracias por elegir Soru! En unos minutos estarás disfrutando de tu comida como se debe ✨`;

      await fetch(API_URL, {
        method: 'POST',
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          codigoPedido: eliminado.codigo,
          nombre: eliminado.nombre,
          estadoAnterior: estadoAnterior,
          nuevoEstado: 'liberado',
          number: eliminado.numero,
          message: msg,
          timestamp: new Date().toISOString()
        })
      });
      // Puedes loggear si quieres
      console.log(`[WhatsApp Liberado] Mensaje enviado para pedido ${eliminado.codigo}`);
    }
  } catch (e) {
    console.error("Error enviando mensaje liberado:", e);
    // Puedes ignorar el error si no quieres interrumpir el flujo
  }

  // 3. Borra el pedido del archivo
  pedidos.splice(idx, 1);
  guardarPedidos(pedidos);

  io.emit('pedido_eliminado', eliminado);

  res.json({ success: true, pedido: eliminado });
});

app.post('/api/cancelarPedido', async (req, res) => {
  const { codigoPedido, motivo } = req.body;
  if (!codigoPedido || !motivo) {
    return res.status(400).json({ success: false, error: 'Faltan datos' });
  }

  // Busca el pedido antes de usarlo
  let pedidos = cargarPedidos();
  const pedido = pedidos.find(p => p.codigo === codigoPedido || p.orderId === codigoPedido);

  if (!pedido) {
    return res.status(404).json({ success: false, error: 'Pedido no encontrado' });
  }

  try {
    await fetch(API_URL, {
      method: 'POST',
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        codigoPedido,
        motivo,
        timestamp: new Date().toISOString(),
        number: pedido.numero, // Ahora sí existe
        message: `⚠️ *Pedido ${codigoPedido}*\n Sentimos mucho que tu pedido no pueda llegar esta vez. \n\n *Motivo de la cancelación:* ${motivo }`
      })
    });

    const sheetsResp = await fetch('https://script.google.com/macros/s/AKfycbzhwNTB1cK11Y3Wm7uiuVrzNmu1HD1IlDTPlAJ37oUDgPIabCWbZqMZr-86mnUDK_JPBA/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `action=actualizarEstadoPedido&codigo=${encodeURIComponent(codigoPedido)}&nuevoEstado=Cancelado`
    });
    const sheetsData = await sheetsResp.json();
    if (sheetsData.estado !== 'ESTADO_ACTUALIZADO') {
      return res.status(500).json({ success: false, error: 'No se pudo actualizar el estado en Sheets.' });
    }

    // Borrar localmente
    const idx = pedidos.findIndex(p => p.codigo === codigoPedido || p.orderId === codigoPedido);
    if (idx === -1) {
      return res.status(404).json({ success: false, error: 'Pedido no encontrado' });
    }
    const eliminado = pedidos.splice(idx, 1)[0];
    guardarPedidos(pedidos);

    io.emit('pedido_eliminado', eliminado);

    res.json({ success: true });
  } catch (err) {
    console.error("Error en cancelarPedido:", err);
    res.status(500).json({ success: false, error: 'Error al cancelar el pedido.' });
  }
});

app.post('/api/verificarPassword', async (req, res) => {
  const { email, password } = req.body;
  try {
    const response = await fetch('https://script.google.com/macros/s/AKfycbzhwNTB1cK11Y3Wm7uiuVrzNmu1HD1IlDTPlAJ37oUDgPIabCWbZqMZr-86mnUDK_JPBA/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'verificarPassword',
        email,
        password
      })
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Error al verificar la contraseña.' });
  }
});

app.post('/api/cambiarPassword', async (req, res) => {
  const { email, nuevaPassword} = req.body;

  try {
    const response = await fetch('https://script.google.com/macros/s/AKfycbzhwNTB1cK11Y3Wm7uiuVrzNmu1HD1IlDTPlAJ37oUDgPIabCWbZqMZr-86mnUDK_JPBA/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'cambiarPassword',
        email,
        nuevaPassword
      })
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Error al cambiar la contraseña.' });
  }
});

app.get('/api/corte', async (req, res) => {
  const sucursal = req.query.sucursal;
  if (!sucursal) {
    return res.status(400).json({ error: 'Falta el parámetro de sucursal' });
  }

  function getMexicoDate(dateObj) {
    return new Date(dateObj.toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
  }

  try {
    // Usa BACKTICKS aquí ⬇️
    const url = `https://script.google.com/macros/s/AKfycbzhwNTB1cK11Y3Wm7uiuVrzNmu1HD1IlDTPlAJ37oUDgPIabCWbZqMZr-86mnUDK_JPBA/exec?action=getPedidos&sucursal=${encodeURIComponent(sucursal)}&estados=liberado`;
    const response = await fetch(url);
    const data = await response.json();
    const pedidos = Array.isArray(data.pedidos) ? data.pedidos : [];

    const ahora = getMexicoDate(new Date());

    function esMismoDia(pedido) {
      const fecha = pedido.fecha || pedido.Fecha || pedido.date || pedido.Date;
      if (!fecha) return false;
      let pedidoDateObj = new Date(fecha);
      if (isNaN(pedidoDateObj)) return false;
      const pedidoLocal = getMexicoDate(pedidoDateObj);
      return (
        pedidoLocal.getFullYear() === ahora.getFullYear() &&
        pedidoLocal.getMonth() === ahora.getMonth() &&
        pedidoLocal.getDate() === ahora.getDate()
      );
    }

    const pedidosDelDia = pedidos.filter(esMismoDia);

    let efectivo = 0, tarjeta = 0, ventaSucursal = 0;
    pedidosDelDia.forEach(p => {
      const pago = (p.pago || p.payMethod || p.metodoPago || '').toLowerCase();
      const totalPedido = parseFloat(p.total) || 0;
      if (pago === 'efectivo') efectivo += totalPedido;
      else if (pago === 'tarjeta') tarjeta += totalPedido;
      else {
        ventaSucursal += totalPedido;
        console.warn('Pedido sin método de pago (sumado a "ventaSucursal"):', p);
      }
    });

    const total = efectivo + tarjeta + ventaSucursal;

    res.json({
      efectivo: efectivo.toFixed(2),
      tarjeta: tarjeta.toFixed(2),
      ventaSucursal: ventaSucursal.toFixed(2),
      total: total.toFixed(2)
    });
  } catch (err) {
    console.error("Error en corte desde sheets:", err);
    res.status(500).json({ error: 'Error al obtener el corte desde Sheets.' });
  }
});

app.post('/api/enviarCorte', async (req, res) => {
  try {
    const restaurante = (req.body.restaurante || 'Soru')
    const { sucursal, nombreDestinatario, correoDestinatario } = req.body;
    if (!sucursal || !correoDestinatario) {
      return res.status(400).json({ error: 'Faltan datos para enviar el corte' });
    }

    // 1. Pide los pedidos liberados y cancelados a tu Apps Script
    const corteResp = await fetch(
      'https://script.google.com/macros/s/AKfycbzhwNTB1cK11Y3Wm7uiuVrzNmu1HD1IlDTPlAJ37oUDgPIabCWbZqMZr-86mnUDK_JPBA/exec?action=getPedidos&sucursal=' +
      encodeURIComponent(sucursal) + '&estados=liberado,cancelado' + '&restaurante=' + encodeURIComponent(restaurante)
    );
    const data = await corteResp.json();

    // 2. Filtra por fecha de hoy (formato dd/mm/yyyy)
    function esMismoDia(pedido) {
    const fechaRaw = pedido.fecha || pedido.Fecha || pedido.date || pedido.Date;
    if (!fechaRaw) return false;

    // Si la fecha viene como ISO (incluye "T")
    if (fechaRaw.includes('T')) {
      const utcDate = new Date(fechaRaw);
      const mxDateStr = utcDate.toLocaleString('en-US', { timeZone: 'America/Mexico_City' });
      const mxDate = new Date(mxDateStr);
      const ahora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
      return (
        mxDate.getFullYear() === ahora.getFullYear() &&
        mxDate.getMonth() === ahora.getMonth() &&
        mxDate.getDate() === ahora.getDate()
      );
    }

    // Si la fecha viene como dd/mm/yyyy
    if (/^\d{2}\/\d{2}\/\d{4}/.test(fechaRaw)) {
      const soloFecha = fechaRaw.split(' ')[0];
      const [dia, mes, anio] = soloFecha.split('/');
      const pedidoDateObj = new Date(`${anio}-${mes}-${dia}`);
      if (isNaN(pedidoDateObj)) return false;
      const ahora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
      return (
        pedidoDateObj.getFullYear() === ahora.getFullYear() &&
        pedidoDateObj.getMonth() === ahora.getMonth() &&
        pedidoDateObj.getDate() === ahora.getDate()
      );
    }

    // Si la fecha viene como yyyy-mm-dd
    if (/^\d{4}-\d{2}-\d{2}/.test(fechaRaw)) {
      const pedidoDateObj = new Date(fechaRaw);
      const ahora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
      return (
        pedidoDateObj.getFullYear() === ahora.getFullYear() &&
        pedidoDateObj.getMonth() === ahora.getMonth() &&
        pedidoDateObj.getDate() === ahora.getDate()
      );
    }

    return false;
  }

    const pedidos = Array.isArray(data.pedidos) ? data.pedidos : [];
    const pedidosDelDia = pedidos.filter(esMismoDia);

    // Debug: verifica cómo viene la fecha y los pedidos filtrados
    console.log("Fechas recibidas:", pedidos.map(p => p.fecha || p.Fecha || p.date || p.Date));
    console.log("Pedidos del día:", pedidosDelDia);

    // 3. Estadísticas igual que en el dashboard
    const eliminados = pedidosDelDia.filter(p => (p.estado || p.Estado || '').toLowerCase() === 'cancelado');
    const liberados = pedidosDelDia.filter(p => (p.estado || p.Estado || '').toLowerCase() === 'liberado');
    const tiempos = liberados.map(p => parseInt(p.tiempo || p.Tiempo)).filter(t => !isNaN(t));
    const promedioTiempo = tiempos.length > 0
      ? Math.round(tiempos.reduce((a, b) => a + b, 0) / tiempos.length)
      : 0;

    // 4. Suma de ventas
    let efectivo = 0, tarjeta = 0, ventaSucursal = 0;
    liberados.forEach(p => {
      const pago = (p.pago || p.payMethod || p.metodoPago || '').toLowerCase();
      const totalPedido = parseFloat(p.total) || 0;
      if (pago === 'efectivo') efectivo += totalPedido;
      else if (pago === 'tarjeta') tarjeta += totalPedido;
      else ventaSucursal += totalPedido;
    });
    const total = efectivo + tarjeta + ventaSucursal;

    // Debug totals
    console.log({
      eliminados: eliminados.length,
      liberados: liberados.length,
      promedioTiempo,
      efectivo,
      tarjeta,
      ventaSucursal,
      total
    });

    // 5. Genera el PDF con puppeteer (usando plantilla HTML)
    // Logo en base64 (opcional)
    let logoDataURI = '';
    try {
      const logoPath = path.join(__dirname, '../../frontend/src/Img/Logo_soru.png');
      if (fs.existsSync(logoPath)) {
        const logoBase64 = fs.readFileSync(logoPath, { encoding: 'base64' });
        logoDataURI = `data:image/png;base64,${logoBase64}`;
      }
    } catch (e) {
      logoDataURI = '';
    }

    // Lee la plantilla HTML
    const templateHtml = fs.readFileSync(path.join(__dirname, '../../frontend/src/pages/pdf.html'), 'utf8');
    const handlebars = require('handlebars');
    const template = handlebars.compile(templateHtml);

    // Fecha para el PDF
    const fechaMX = new Date().toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City' });

    // Rellena los datos en la plantilla
    const htmlConDatos = template({
      sucursal,
      nombreEmpresa: "Sushi Soru Restaurant",
      fecha: fechaMX,
      eliminados: eliminados.length,
      liberados: liberados.length,
      tiempoPromedio: promedioTiempo,
      total: total.toFixed(2),
      efectivo: efectivo.toFixed(2),
      tarjeta: tarjeta.toFixed(2),
      ventaSucursal: ventaSucursal.toFixed(2),
      logoBase64: logoDataURI
    });

    // Genera el PDF con puppeteer
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser', // Ajusta según tu sistema
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setContent(htmlConDatos, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
    await browser.close();

    // 6. Envía el correo con el PDF adjunto
    let transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: 'dannyglezhdzo@gmail.com', // Cambia por tu correo real
        pass: 'jexh anjd wkqi znof'      // Contraseña de aplicación
      }
    });

    await transporter.sendMail({
      from: 'Sushi Soru Restaurant <dannyglezhdzo@gmail.com>',
      to: correoDestinatario,
      subject: `Corte de caja - ${sucursal} - ${fechaMX}`,
      text: `Corte de caja generado por ${nombreDestinatario || correoDestinatario}`,
      attachments: [
        {
          filename: `Corte_${sucursal}_${fechaMX.replace(/\//g, '-')}.pdf`,
          content: pdfBuffer
        }
      ]
    });

    res.json({ enviado: true });
  } catch (err) {
    console.error("Error al enviar el corte:", err);
    res.status(500).json({ error: 'Error al enviar el corte.' });
  }
});

app.get('/api/pedidos.json', (req, res) => {
  const restauranteQ = (req.query.restaurante || 'Soru').toString().trim();
  const pedidos = cargarPedidos(restauranteQ);
  res.json(pedidos);
});

server.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
