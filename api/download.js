export default async function handler(req, res) {
  const { url, name } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'URL required' });
  }

  try {
    console.log('Fetching:', url);

    // Fetch from Telegram
    const response = await fetch(url);
    
    if (!response.ok) {
      console.error('Telegram fetch failed:', response.status, response.statusText);
      return res.status(response.status).json({ 
        error: `Telegram API error: ${response.status}` 
      });
    }

    // Get file as array buffer
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Clean filename
    const safeName = (name || 'music.mp3').replace(/[<>:"/\\|?*]/g, '_');

    // Set headers for download
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeName)}"`);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'no-cache');

    // Send file
    res.send(buffer);

  } catch (error) {
    console.error('Download API error:', error);
    res.status(500).json({ 
      error: 'Download failed',
      details: error.message 
    });
  }
}
