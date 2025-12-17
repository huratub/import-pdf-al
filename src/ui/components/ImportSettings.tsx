import React from 'react';

interface ImportSettingsProps {
    fileName: string;
    onCancel: () => void;
    onImport: (settings: any) => void;
}

export const ImportSettings: React.FC<ImportSettingsProps> = ({ fileName, onCancel, onImport }) => {
    return (
        <div className="layout-col" style={{ padding: 20 }}>
            <h2>Import Settings</h2>
            <p style={{ marginBottom: 20 }}>File: {fileName}</p>

            <div style={{ marginBottom: 20 }}>
                <label style={{ display: 'block', marginBottom: 8, fontWeight: 500 }}>Import mode</label>
                <div style={{ display: 'flex', gap: 10 }}>
                    <label>
                        <input type="radio" name="mode" defaultChecked /> Editable Layers
                    </label>
                    <label style={{ opacity: 0.5 }}>
                        <input type="radio" name="mode" disabled /> Images (Coming soon)
                    </label>
                </div>
            </div>

            <div style={{ marginTop: 'auto', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button className="secondary" onClick={onCancel}>Cancel</button>
                <button className="primary" onClick={() => onImport({ mode: 'editable' })}>Import</button>
            </div>
        </div>
    );
};
