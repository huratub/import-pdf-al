import React, { useState } from 'react';
import { Dropzone } from './components/Dropzone';
import { ImportSettings } from './components/ImportSettings';
import { PDFProcessor } from './worker/pdf-processor';

type Step = 'dropzone' | 'settings' | 'processing' | 'complete';

const App = () => {
    const [step, setStep] = useState<Step>('dropzone');
    const [file, setFile] = useState<File | null>(null);

    const handleFileSelect = (selectedFile: File) => {
        setFile(selectedFile);
        setStep('settings');
    };

    const handleCancel = () => {
        setFile(null);
        setStep('dropzone');
    };

    const handleImport = async (settings: any) => {
        if (!file) return;
        setStep('processing');

        try {
            const arrayBuffer = await file.arrayBuffer();
            // Static import usage
            const processor = new PDFProcessor();

            console.log("Loading PDF...");
            const numPages = await processor.load(arrayBuffer);
            console.log(`PDF Loaded with ${numPages} pages.`);

            // Process pages one by one to avoid UI freezing
            for (let i = 0; i < numPages; i++) {
                console.log(`Processing page ${i + 1}/${numPages}`);
                const pageData = await processor.getPageData(i);

                // Send to main thread
                parent.postMessage({
                    pluginMessage: {
                        type: 'create-page',
                        index: i,
                        data: pageData
                    }
                }, '*');
            }

            console.log("Processing complete.");
            setStep('complete');
        } catch (error) {
            console.error("Error processing PDF:", error);
            alert("Failed to process PDF. See console for details.");
            setStep('settings'); // Go back
        }
    };

    return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
            <div className="header">
                <span style={{ fontWeight: 600 }}>PDF Importer</span>
            </div>

            {step === 'dropzone' && (
                <Dropzone onFileSelect={handleFileSelect} />
            )}

            {step === 'settings' && file && (
                <ImportSettings
                    fileName={file.name}
                    onCancel={handleCancel}
                    onImport={handleImport}
                />
            )}

            {step === 'processing' && (
                <div style={{ padding: 20, textAlign: 'center', marginTop: 40 }}>
                    <div style={{ marginBottom: 16 }}>
                        {/* Simple CSS Spinner */}
                        <svg style={{ animation: 'spin 1s linear infinite' }} width="24" height="24" viewBox="0 0 24 24" fill="none">
                            <path d="M12 4V2M12 22V20M4 12H2M22 12H20M5 5L3.5 3.5M19 5L20.5 3.5M5 19L3.5 20.5M19 19L20.5 20.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                    </div>
                    <h2>Processing...</h2>
                    <p style={{ opacity: 0.6 }}>Check your Figma canvas.</p>
                    <style>{`@keyframes spin { 100% { transform: rotate(360deg); } }`}</style>
                </div>
            )}

            {step === 'complete' && (
                <div style={{ padding: 20, textAlign: 'center', marginTop: 40 }}>
                    <h2 style={{ color: '#10B981', marginBottom: 8 }}>Import Complete!</h2>
                    <p style={{ marginBottom: 24 }}>Your PDF has been imported to the canvas.</p>
                    <button className="primary" onClick={() => setStep('dropzone')}>Import Another</button>
                </div>
            )}
        </div>
    );
};

export default App;
