import React from 'react';

export default function Home() {
  return (
    <div style={{
      background: '#0B1429',
      color: '#E8E6E1',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '20px'
    }}>
      <div style={{
        textAlign: 'center',
        maxWidth: '600px'
      }}>
        <h1 style={{
          fontSize: '42px',
          marginBottom: '20px',
          letterSpacing: '2px',
          color: '#C8A96A'
        }}>
          🎙️ Victor IA Agent v3.0
        </h1>

        <p style={{
          fontSize: '16px',
          lineHeight: '1.8',
          marginBottom: '30px',
          color: '#9A9A9F'
        }}>
          Sistema profesional de reportes de entrenamiento para Victorious Travelers Club
        </p>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: '20px',
          marginBottom: '30px'
        }}>
          <div style={{
            background: 'rgba(200, 169, 106, 0.1)',
            padding: '20px',
            borderRadius: '8px',
            borderLeft: '3px solid #C8A96A'
          }}>
            <h3 style={{ color: '#C8A96A', marginBottom: '10px' }}>✅ Status</h3>
            <p style={{ fontSize: '14px' }}>🟢 Production Ready</p>
          </div>

          <div style={{
            background: 'rgba(200, 169, 106, 0.1)',
            padding: '20px',
            borderRadius: '8px',
            borderLeft: '3px solid #4CAF50'
          }}>
            <h3 style={{ color: '#4CAF50', marginBottom: '10px' }}>🚀 Deployment</h3>
            <p style={{ fontSize: '14px' }}>Vercel Live</p>
          </div>
        </div>

        <div style={{
          background: 'rgba(200, 169, 106, 0.1)',
          padding: '20px',
          borderRadius: '8px',
          marginBottom: '30px'
        }}>
          <h3 style={{ color: '#C8A96A', marginBottom: '15px' }}>📚 Documentación</h3>
          <ul style={{
            listStyle: 'none',
            padding: '0',
            textAlign: 'left',
            display: 'inline-block'
          }}>
            <li style={{ marginBottom: '10px' }}>
              📖 <a href="https://github.com/mesainteligentedemo-cell/victor-ia-agent"
                style={{ color: '#C8A96A', textDecoration: 'none' }}>
                GitHub Repo
              </a>
            </li>
            <li style={{ marginBottom: '10px' }}>
              🔗 <code style={{ background: '#1a2a4a', padding: '4px 8px', borderRadius: '4px' }}>
                /api/health
              </code>
            </li>
            <li>
              🎙️ Pop-up Reproductor: <code style={{ background: '#1a2a4a', padding: '4px 8px', borderRadius: '4px' }}>
                /player?conv=ID
              </code>
            </li>
          </ul>
        </div>

        <footer style={{
          fontSize: '12px',
          color: '#9A9A9F',
          marginTop: '30px',
          paddingTop: '20px',
          borderTop: '1px solid rgba(200, 169, 106, 0.2)'
        }}>
          VTC ELITE TRAINING v3.0 · © 2026 Victorious Travelers Club
        </footer>
      </div>
    </div>
  );
}