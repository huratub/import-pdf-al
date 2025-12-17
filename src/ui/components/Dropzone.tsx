import React, { useCallback, useState } from 'react';

interface DropzoneProps {
    onFileSelect: (file: File) => void;
}

export const Dropzone: React.FC<DropzoneProps> = ({ onFileSelect }) => {
    const [isDragOver, setIsDragOver] = useState(false);

    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(true);
    }, []);

    const handleDragLeave = useCallback(() => {
        setIsDragOver(false);
    }, []);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(false);

        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            const file = e.dataTransfer.files[0];
            if (file.type === 'application/pdf') {
                onFileSelect(file);
            } else {
                alert('Please drop a PDF file.');
            }
        }
    }, [onFileSelect]);

    const handleBrowse = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/pdf';
        input.onchange = (e: any) => {
            const file = e.target.files[0];
            if (file) onFileSelect(file);
        };
        input.click();
    };

    return (
        <div
            className={`dropzone ${isDragOver ? 'active' : ''}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >
            <div style={{ marginBottom: 16 }}>
                <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M24 32V16M24 16L18 22M24 16L30 22" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M10 32V36C10 37.1046 10.8954 38 12 38H36C37.1046 38 38 37.1046 38 36V32" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
            </div>
            <h3 style={{ marginBottom: 8 }}>Drop PDF here</h3>
            <p style={{ marginBottom: 24 }}>or</p>
            <button className="primary" onClick={handleBrowse}>Browse files</button>
            <p style={{ marginTop: 24, fontSize: 10, opacity: 0.5 }}>.PDF files only</p>
        </div>
    );
};
