require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const mysql      = require('mysql2/promise');

const app = express();

// ── DB POOL ──
const pool = mysql.createPool({
  host:            process.env.DB_HOST     || '89.117.56.39',
  port:            parseInt(process.env.DB_PORT) || 3308,
  database:        process.env.DB_NAME     || 'motos_app',
  user:            process.env.DB_USER     || 'pos_user_moto',
  password:        process.env.DB_PASSWORD || 'M0t0s!4#S3cur3_2026',
  waitForConnections: true,
  connectionLimit: 10,
  charset:         'utf8mb4'
});

// ── MIDDLEWARE ──
app.use(express.json({ limit: '10mb' }));
app.use(cors({
  origin: '*',
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','x-api-key']
}));
app.use(rateLimit({ windowMs: 60*1000, max: 300 }));

// ── HEALTH ──
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', ts: new Date() });
  } catch(e) {
    res.status(500).json({ status: 'error', db: e.message });
  }
});

// ════════════════════════════════
// PRODUCTOS
// ════════════════════════════════

// GET todos
app.get('/api/productos', async (req, res) => {
  try {
    const { nombre, codigo, stock_max, precio_min, precio_max, orden } = req.query;
    let sql = 'SELECT * FROM productos WHERE 1=1';
    const params = [];
    if (nombre)     { sql += ' AND nombre LIKE ?';        params.push('%'+nombre+'%'); }
    if (codigo)     { sql += ' AND id LIKE ?';            params.push('%'+codigo+'%'); }
    if (stock_max)  { sql += ' AND stock <= ?';           params.push(parseInt(stock_max)); }
    if (precio_min) { sql += ' AND precio_venta >= ?';    params.push(parseFloat(precio_min)); }
    if (precio_max) { sql += ' AND precio_venta <= ?';    params.push(parseFloat(precio_max)); }
    if (orden === 'salidas')     sql += ' ORDER BY salidas DESC';
    else if (orden === 'stock')  sql += ' ORDER BY stock DESC';
    else                         sql += ' ORDER BY nombre ASC';
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET uno
app.get('/api/productos/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM productos WHERE id=?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'No encontrado' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST crear
app.post('/api/productos', async (req, res) => {
  try {
    const { id, nombre, precio_venta, precio_compra, stock, imagen } = req.body;
    if (!id || !nombre || precio_venta == null || stock == null)
      return res.status(400).json({ error: 'Faltan campos' });
    await pool.query(
      'INSERT INTO productos (id,nombre,precio_venta,precio_compra,stock,entradas,salidas,imagen) VALUES (?,?,?,?,?,?,0,?)',
      [id, nombre, precio_venta, precio_compra, stock, stock, imagen || null]
    );
    const [rows] = await pool.query('SELECT * FROM productos WHERE id=?', [id]);
    res.status(201).json(rows[0]);
  } catch(e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Código ya existe' });
    res.status(500).json({ error: e.message });
  }
});

// PUT actualizar
app.put('/api/productos/:id', async (req, res) => {
  try {
    const { nombre, precio_venta, precio_compra, stock, imagen } = req.body;
    const [old] = await pool.query('SELECT stock, entradas FROM productos WHERE id=?', [req.params.id]);
    if (!old.length) return res.status(404).json({ error: 'No encontrado' });
    const diffE = stock > old[0].stock ? stock - old[0].stock : 0;
    await pool.query(
      'UPDATE productos SET nombre=?, precio_venta=?, precio_compra=?, stock=?, entradas=entradas+?, imagen=? WHERE id=?',
      [nombre, precio_venta, precio_compra, stock, diffE, imagen !== undefined ? imagen : null, req.params.id]
    );
    const [rows] = await pool.query('SELECT * FROM productos WHERE id=?', [req.params.id]);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH solo stock
app.patch('/api/productos/:id/stock', async (req, res) => {
  try {
    const { stock } = req.body;
    const [old] = await pool.query('SELECT stock FROM productos WHERE id=?', [req.params.id]);
    if (!old.length) return res.status(404).json({ error: 'No encontrado' });
    const diffE = stock > old[0].stock ? stock - old[0].stock : 0;
    await pool.query(
      'UPDATE productos SET stock=?, entradas=entradas+? WHERE id=?',
      [stock, diffE, req.params.id]
    );
    const [rows] = await pool.query('SELECT * FROM productos WHERE id=?', [req.params.id]);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE eliminar (solo sin ventas)
app.delete('/api/productos/:id', async (req, res) => {
  try {
    const [check] = await pool.query('SELECT COUNT(*) as cnt FROM venta_productos WHERE producto_id=?', [req.params.id]);
    if (check[0].cnt > 0) return res.status(409).json({ error: 'Tiene ventas asociadas' });
    await pool.query('DELETE FROM productos WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST importar masivo
app.post('/api/productos/importar', async (req, res) => {
  try {
    const { productos } = req.body;
    if (!Array.isArray(productos)) return res.status(400).json({ error: 'Array requerido' });
    let added=0, updated=0, errors=0;
    for (const p of productos) {
      const { id, nombre, precio_venta, precio_compra, stock, imagen } = p;
      if (!id || !nombre) { errors++; continue; }
      const [old] = await pool.query('SELECT stock,entradas,imagen FROM productos WHERE id=?', [id]);
      if (old.length) {
        const dE = stock > old[0].stock ? stock - old[0].stock : 0;
        await pool.query(
          'UPDATE productos SET nombre=?,precio_venta=?,precio_compra=?,stock=?,entradas=entradas+?,imagen=? WHERE id=?',
          [nombre, precio_venta, precio_compra, stock, dE, imagen !== undefined ? imagen : old[0].imagen, id]
        );
        updated++;
      } else {
        await pool.query(
          'INSERT INTO productos (id,nombre,precio_venta,precio_compra,stock,entradas,salidas,imagen) VALUES (?,?,?,?,?,?,0,?)',
          [id, nombre, precio_venta, precio_compra, stock, stock, imagen || null]
        );
        added++;
      }
    }
    res.json({ added, updated, errors });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════
// VENTAS
// ════════════════════════════════

// GET ventas por fecha/estado
app.get('/api/ventas', async (req, res) => {
  try {
    const { fecha, estado } = req.query;
    let sql = 'SELECT * FROM ventas WHERE 1=1';
    const params = [];
    if (fecha)  { sql += ' AND fecha=?';  params.push(fecha); }
    if (estado) { sql += ' AND estado=?'; params.push(estado); }
    sql += ' ORDER BY created_at DESC';
    const [ventas] = await pool.query(sql, params);
    // cargar productos de cada venta
    for (const v of ventas) {
      const [prods] = await pool.query('SELECT * FROM venta_productos WHERE venta_id=?', [v.id]);
      v.productos = prods;
      v.metodos_pago = typeof v.metodos_pago === 'string' ? JSON.parse(v.metodos_pago||'[]') : (v.metodos_pago||[]);
    }
    res.json(ventas);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET resumen del día
app.get('/api/ventas/resumen/:fecha', async (req, res) => {
  try {
    const [ventas] = await pool.query(
      'SELECT v.*, vp.precio_unitario, vp.cantidad, vp.subtotal, vp.producto_id FROM ventas v LEFT JOIN venta_productos vp ON v.id=vp.venta_id WHERE v.fecha=? AND v.estado="aceptada"',
      [req.params.fecha]
    );
    const totalVendido = [...new Set(ventas.map(v=>v.id))].reduce((s,id) => {
      const v = ventas.find(x=>x.id===id); return s + parseFloat(v.total||0);
    }, 0);
    // por método
    const byMethod = {};
    const seen = new Set();
    for (const v of ventas) {
      if (seen.has(v.id)) continue; seen.add(v.id);
      const mp = typeof v.metodos_pago === 'string' ? JSON.parse(v.metodos_pago||'[]') : (v.metodos_pago||[]);
      mp.forEach(r => { byMethod[r.metodo] = (byMethod[r.metodo]||0) + parseFloat(r.monto||0); });
    }
    // utilidad
    const prodIds = [...new Set(ventas.map(v=>v.producto_id).filter(Boolean))];
    let costoMap = {};
    if (prodIds.length) {
      const [prods] = await pool.query('SELECT id, precio_compra FROM productos WHERE id IN (?)', [prodIds]);
      prods.forEach(p => { costoMap[p.id] = parseFloat(p.precio_compra); });
    }
    let utilidad = 0;
    ventas.forEach(v => { utilidad += (parseFloat(v.precio_unitario||0) - (costoMap[v.producto_id]||0)) * parseInt(v.cantidad||0); });
    res.json({ totalVendido, utilidad, pct: totalVendido>0?(utilidad/totalVendido*100):0, byMethod, cantVentas: seen.size });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET venta por folio
app.get('/api/ventas/:folio', async (req, res) => {
  try {
    const [ventas] = await pool.query('SELECT * FROM ventas WHERE folio=?', [req.params.folio]);
    if (!ventas.length) return res.status(404).json({ error: 'No encontrado' });
    const venta = ventas[0];
    const [prods] = await pool.query('SELECT * FROM venta_productos WHERE venta_id=?', [venta.id]);
    venta.productos = prods;
    venta.metodos_pago = typeof venta.metodos_pago === 'string' ? JSON.parse(venta.metodos_pago||'[]') : (venta.metodos_pago||[]);
    res.json(venta);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST crear venta
app.post('/api/ventas', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { folio, fecha, hora, cliente, observaciones, metodo_pago, metodos_pago, total, cambio, productos } = req.body;
    if (!folio||!fecha||!hora||!total||!productos?.length) {
      await conn.rollback(); conn.release();
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }
    // Insertar venta
    const [result] = await conn.query(
      'INSERT INTO ventas (folio,fecha,hora,cliente,observaciones,metodo_pago,metodos_pago,total,cambio,estado) VALUES (?,?,?,?,?,?,?,?,?,"aceptada")',
      [folio, fecha, hora, cliente||'222222 - CLIENTE POS', observaciones||'', metodo_pago||'', JSON.stringify(metodos_pago||[]), total, cambio||0]
    );
    const ventaId = result.insertId;
    // Insertar detalle + descontar stock
    for (const p of productos) {
      await conn.query(
        'INSERT INTO venta_productos (venta_id,producto_id,nombre,cantidad,precio_unitario,subtotal) VALUES (?,?,?,?,?,?)',
        [ventaId, p.codigo, p.nombre, p.cantidad, p.precioUnitario, p.subtotal]
      );
      await conn.query(
        'UPDATE productos SET stock=GREATEST(0,stock-?), salidas=salidas+? WHERE id=?',
        [p.cantidad, p.cantidad, p.codigo]
      );
    }
    await conn.commit(); conn.release();
    const [rows] = await pool.query('SELECT * FROM ventas WHERE id=?', [ventaId]);
    res.status(201).json(rows[0]);
  } catch(e) {
    await conn.rollback(); conn.release();
    if (e.code==='ER_DUP_ENTRY') return res.status(409).json({ error: 'Folio duplicado' });
    res.status(500).json({ error: e.message });
  }
});

// PATCH anular venta
app.patch('/api/ventas/:folio/anular', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [ventas] = await conn.query('SELECT * FROM ventas WHERE folio=?', [req.params.folio]);
    if (!ventas.length) { await conn.rollback(); conn.release(); return res.status(404).json({ error: 'No encontrada' }); }
    const venta = ventas[0];
    if (venta.estado==='anulada') { await conn.rollback(); conn.release(); return res.status(409).json({ error: 'Ya anulada' }); }
    // Restituir stock
    const [prods] = await conn.query('SELECT * FROM venta_productos WHERE venta_id=?', [venta.id]);
    for (const p of prods) {
      await conn.query(
        'UPDATE productos SET stock=stock+?, salidas=GREATEST(0,salidas-?) WHERE id=?',
        [p.cantidad, p.cantidad, p.producto_id]
      );
    }
    await conn.query('UPDATE ventas SET estado="anulada" WHERE folio=?', [req.params.folio]);
    await conn.commit(); conn.release();
    res.json({ ok: true, folio: req.params.folio, estado: 'anulada' });
  } catch(e) {
    await conn.rollback(); conn.release();
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════
// CONFIGURACION
// ════════════════════════════════

app.get('/api/configuracion', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM configuracion LIMIT 1');
    if (!rows.length) return res.status(404).json({ error: 'Sin configuración' });
    const cfg = rows[0];
    cfg.metodos_pago = typeof cfg.metodos_pago === 'string' ? JSON.parse(cfg.metodos_pago||'[]') : (cfg.metodos_pago||[]);
    res.json(cfg);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/configuracion/:id', async (req, res) => {
  try {
    const { nombre_negocio, direccion, telefono, logo, metodos_pago, mensaje_tirilla, stock_critico, tamano_ticket } = req.body;
    await pool.query(
      'UPDATE configuracion SET nombre_negocio=?,direccion=?,telefono=?,logo=?,metodos_pago=?,mensaje_tirilla=?,stock_critico=?,tamano_ticket=? WHERE id=?',
      [nombre_negocio, direccion, telefono, logo||null, JSON.stringify(metodos_pago||[]), mensaje_tirilla, stock_critico||10, tamano_ticket||'80mm', req.params.id]
    );
    const [rows] = await pool.query('SELECT * FROM configuracion WHERE id=?', [req.params.id]);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── START ──
const PORT = process.env.PORT || 3005;
app.listen(PORT, () => console.log(`API POS corriendo en puerto ${PORT}`));

module.exports = app;
