// DOM Elements
const editor = document.getElementById('editor');
const gutter = document.getElementById('gutter');
const dropOverlay = document.getElementById('drop-overlay');
const welcomeScreen = document.getElementById('welcome-screen');
const editorHeader = document.getElementById('editor-header');
const historyBtn = document.getElementById('history-btn');
const historyModal = document.getElementById('history-modal');
const historyList = document.getElementById('history-list');
const closeHistoryBtn = document.getElementById('close-history-btn');
const fileNameDisplay = document.getElementById('file-name');
const saveBtn = document.getElementById('save-btn');
const globalCopyBtn = document.getElementById('global-copy-btn');
const globalExportBtn = document.getElementById('global-export-btn');
const restoreBtn = document.getElementById('restore-btn');
const themeToggle = document.getElementById('theme-toggle');
const zoomInBtn = document.getElementById('zoom-in');
const zoomOutBtn = document.getElementById('zoom-out');
const undoBtn = document.getElementById('undo-btn');
const redoBtn = document.getElementById('redo-btn');
const editorWrapper = document.querySelector('.editor-wrapper');

// Note UI Elements
const floatBtn = document.getElementById('add-note-float-btn');
const notePopup = document.getElementById('note-popup');
const noteInput = document.getElementById('note-input');
const noteSaveBtn = document.getElementById('note-save-btn');
const noteDeleteBtn = document.getElementById('note-delete-btn');
const noteCancelBtn = document.getElementById('note-cancel-btn');
const tooltip = document.getElementById('note-hover-tooltip');

// State
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
let currentFileName = "document.md";
let saveTimeout = null;
let lastSavedContent = ""; // Track last saved state to prevent redundant writes
let currentFontSize = parseFloat(localStorage.getItem('novel_editor_font_size')) || 1.25;
let activeMarkElement = null;
let batchSizeLimit = 4000;

// File System State
let mainFileHandle = null;
let dirHandle = null;
let backupFileHandle = null;
let commentsFileHandle = null;

function setEditorFontSize(size) {
    currentFontSize = size;
    localStorage.setItem('novel_editor_font_size', currentFontSize);
    editor.style.setProperty('font-size', currentFontSize + 'rem', 'important');
}

// Apply saved font size
setEditorFontSize(currentFontSize);

function init() {
    const hasNewBackup = localStorage.getItem('novel_editor_backup_text');
    const hasOldBackup = localStorage.getItem('novel_editor_backup_content');
    if (hasNewBackup || hasOldBackup) restoreBtn.classList.remove('hidden');

    // Platform specific UI hiding
    const dragInstruction = document.querySelector('.instruction');
    const openBtn = document.getElementById('open-btn');
    if (isMobile) {
        if (dragInstruction) dragInstruction.style.display = 'none';
    } else {
        if (openBtn) openBtn.style.display = 'none';
    }

    // Register Service Worker for offline support
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('sw.js')
                .then(reg => console.log('Service Worker registered!', reg))
                .catch(err => console.error('Service Worker registration failed:', err));
        });
    }
}
init();

// --- Formatting & ContentEditable Handlers ---

// Status UI & Heartbeat (Only active on desktop PC to conserve mobile battery)
if (!isMobile) {
    const statusDot = document.createElement('div');
    statusDot.id = 'server-status';
    statusDot.style.cssText = 'position:fixed; top:10px; right:10px; width:12px; height:12px; border-radius:50%; background:#ff4444; z-index:1000; border:2px solid #fff;';
    statusDot.title = 'Server Disconnected';
    document.body.appendChild(statusDot);

    window.updateServerStatus = function(connected) {
        statusDot.style.background = connected ? '#44ff44' : '#ff4444';
        statusDot.title = connected ? 'Server Connected' : 'Server Disconnected';
    };

    // Check server status on load
    fetch('/').then(r => window.updateServerStatus(r.ok)).catch(() => window.updateServerStatus(false));

    // Heartbeat to keep server alive
    setInterval(() => {
        fetch('/heartbeat', { method: 'POST' }).then(r => window.updateServerStatus(r.ok)).catch(() => window.updateServerStatus(false));
    }, 5000);
} else {
    // Dummy handler for mobile to prevent errors
    window.updateServerStatus = function() {};
}

editor.addEventListener('paste', (e) => {
    e.preventDefault();
    let text = (e.originalEvent || e).clipboardData.getData('text/plain');
    
    // Normalize newlines: turn double-newlines (common in MD) into single ones
    text = text.replace(/\r?\n\s*\r?\n/g, '\n');
    
    // Snapshot existing splits to identify ghosts after paste
    const originalSplits = Array.from(editor.querySelectorAll('.batch-split'));
    
    // Use insertHTML with </p><p> to properly create new paragraphs on all platforms (fixes iOS stripping).
    // The previous regex already ensures we don't get empty ghost paragraphs from double newlines.
    let htmlText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    htmlText = htmlText.replace(/\n/g, '</p><p>');
    document.execCommand('insertHTML', false, htmlText);
    
    // Cleanup any ghost classes cloned by the browser during paste
    const currentParagraphs = Array.from(editor.querySelectorAll('p'));
    currentParagraphs.forEach(p => {
        if (p.classList.contains('batch-split') && !originalSplits.includes(p)) {
            p.classList.remove('batch-split');
            p.classList.remove('batch-done');
        }
    });
    
    refreshSplitsUI();
});

editor.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        // Snapshot to prevent cloning split classes
        const originalSplits = Array.from(editor.querySelectorAll('.batch-split'));
        document.execCommand('insertParagraph');
        
        const currentParagraphs = Array.from(editor.querySelectorAll('p'));
        currentParagraphs.forEach(p => {
            if (p.classList.contains('batch-split') && !originalSplits.includes(p)) {
                p.classList.remove('batch-split');
                p.classList.remove('batch-done');
            }
        });
        refreshSplitsUI();
    }
    if (e.key === 'Tab') {
        e.preventDefault();
        document.execCommand('insertText', false, '\t');
    }
});

// --- Note System ---

function parseNotasToHTML(text) {
    return text.replace(/<nota texto="([^"]+)">([\s\S]*?)<\/nota>/g, (match, noteText, content) => {
        const safeNote = noteText.replace(/"/g, '&quot;');
        return `<mark class="note-highlight" data-note="${safeNote}">${content}</mark>`;
    });
}

function parseHTMLToNotas(html, clean = false) {
    const temp = document.createElement('div');
    temp.innerHTML = html;

    // 1. Remove UI elements first
    temp.querySelectorAll('.split-toggle-zone').forEach(z => z.remove());

    // 2. Process notes
    const marks = temp.querySelectorAll('mark.note-highlight');
    marks.forEach(mark => {
        if (clean) mark.outerHTML = mark.innerHTML;
        else {
            const noteText = mark.getAttribute('data-note') || '';
            const content = mark.innerHTML;
            mark.outerHTML = `<nota texto="${noteText}">${content}</nota>`;
        }
    });

    // 3. Extract paragraphs and preserve structure
    const paragraphs = temp.querySelectorAll('p');
    if (paragraphs.length > 0) {
        return Array.from(paragraphs).map(p => {
            let s = p.innerHTML;
            // Convert <br> to \n
            s = s.replace(/<br\s*\/?>/gi, '\n');
            // Remove all other HTML tags except <nota>
            s = s.replace(/<(?!\/?nota\b)[^>]+>/gi, '');
            // Clean up entities and trim whitespace at start/end of paragraph
            return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
        }).filter(s => s.length > 0).join('\n\n');
    } else {
        let result = temp.innerHTML;
        result = result.replace(/<br\s*\/?>/gi, '\n');
        result = result.replace(/<(?!\/?nota\b)[^>]+>/gi, '');
        return result.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
    }
}

// --- Batch & Gutter Logic ---

function isTooClose(idx, paragraphs) {
    if (idx === 0) return true; // Start of document is always Part 1

    // Forbidden if adjacent to an existing break
    if (paragraphs[idx - 1] && paragraphs[idx - 1].classList.contains('batch-split')) return true;
    if (paragraphs[idx + 1] && paragraphs[idx + 1].classList.contains('batch-split')) return true;

    return false;
}

let refreshTimeout = null;
function refreshSplitsUI() {
    if (refreshTimeout) cancelAnimationFrame(refreshTimeout);

    refreshTimeout = requestAnimationFrame(() => {
        const paragraphs = Array.from(editor.querySelectorAll('p'));

        paragraphs.forEach((p, idx) => {
            // Sanity check: prevent browser from cloning 'batch-split' on Enter
            if (p.classList.contains('batch-split') && idx > 0) {
                const prev = paragraphs[idx - 1];
                if (prev && prev.classList.contains('batch-split')) {
                    p.classList.remove('batch-split');
                }
            }

            // Optimization: check last child instead of querySelector
            let zone = p.lastElementChild;
            if (!zone || !zone.classList.contains('split-toggle-zone')) {
                zone = document.createElement('div');
                zone.className = 'split-toggle-zone';
                zone.contentEditable = false;
                zone.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (p.classList.contains('batch-split')) {
                        p.classList.remove('batch-split');
                    } else {
                        const currentParagraphs = Array.from(editor.querySelectorAll('p'));
                        const currentIdx = currentParagraphs.indexOf(p);
                        if (currentIdx !== 0) {
                            p.classList.add('batch-split');
                        }
                    }
                    refreshSplitsUI();
                    triggerAutoBackup();
                });
                p.appendChild(zone);
            }
            const tooClose = isTooClose(idx, paragraphs);
            const isSplit = p.classList.contains('batch-split');
            const isStart = idx === 0;
            zone.style.display = (isSplit || isStart || tooClose) ? 'none' : 'block';
        });
        renderGutter(paragraphs);
        refreshTimeout = null;
    });
}

function updateBatchGuidelines(recalculate = false) {
    const paragraphs = Array.from(editor.querySelectorAll('p'));
    if (recalculate) {
        paragraphs.forEach(p => p.classList.remove('batch-split'));
        let currentCount = 0;
        paragraphs.forEach((p, idx) => {
            const plainText = p.textContent;
            if (currentCount + plainText.length > batchSizeLimit && idx > 0 && !isTooClose(idx, paragraphs)) {
                p.classList.add('batch-split');
                currentCount = plainText.length;
            } else {
                currentCount += plainText.length;
            }
        });
    }
    refreshSplitsUI();
    triggerAutoBackup();
}

function renderGutter(providedParagraphs = null) {
    const paragraphs = providedParagraphs || Array.from(editor.querySelectorAll('p'));
    if (paragraphs.length === 0) return;

    let partNumber = 1;

    paragraphs.forEach((p, idx) => {
        // Clear any old gutter buttons first
        const oldBatch = p.querySelector('.gutter-batch');
        if (oldBatch) oldBatch.remove();

        if (idx === 0) {
            p.appendChild(createGutterBatch(1, p, false));
            partNumber++;
        } else if (p.classList.contains('batch-split')) {
            p.appendChild(createGutterBatch(partNumber, p, true));
            partNumber++;
        }
    });
}

function createGutterBatch(num, targetParagraph, isRemovable) {
    const div = document.createElement('div');
    div.className = 'gutter-batch';
    div.contentEditable = false;

    const label = document.createElement('span');
    label.className = 'batch-label';
    label.textContent = typeof num === 'number' ? `Part ${num}` : num;

    const actions = document.createElement('div');
    actions.className = 'batch-actions';

    const checkBtn = document.createElement('button');
    checkBtn.className = 'btn-secondary batch-btn btn-check';
    checkBtn.innerHTML = targetParagraph.classList.contains('batch-done') ? '✓' : '○';
    checkBtn.title = "Mark as edited";
    checkBtn.onclick = (e) => {
        e.stopPropagation();
        targetParagraph.classList.toggle('batch-done');
        checkBtn.innerHTML = targetParagraph.classList.contains('batch-done') ? '✓' : '○';
        triggerAutoBackup();
    };

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn-secondary batch-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.onclick = () => copyBatch(targetParagraph, false);

    const exportBtn = document.createElement('button');
    exportBtn.className = 'btn-primary batch-btn';
    exportBtn.textContent = 'Export';
    exportBtn.onclick = () => copyBatch(targetParagraph, true);

    actions.appendChild(checkBtn);
    actions.appendChild(copyBtn);
    actions.appendChild(exportBtn);

    if (isRemovable) {
        const removeBtn = document.createElement('button');
        removeBtn.className = 'btn-secondary batch-btn danger';
        removeBtn.textContent = 'Remove Split';
        removeBtn.onclick = () => {
            targetParagraph.classList.remove('batch-split');
            refreshSplitsUI();
        };
        actions.appendChild(removeBtn);
    }

    div.appendChild(label);
    div.appendChild(actions);
    return div;
}

function getBatchHTML(startParagraph) {
    let html = startParagraph.outerHTML;
    let current = startParagraph.nextSibling;
    while (current) {
        if (current.nodeType === 1 && current.classList.contains('batch-split')) break;
        html += (current.nodeType === 1 ? current.outerHTML : (current.textContent || ""));
        current = current.nextSibling;
    }
    return html;
}

// --- Clipboard Utility ---
async function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
        try {
            await navigator.clipboard.writeText(text);
            return;
        } catch (e) {
            console.warn("Clipboard API failed, falling back...", e);
        }
    }
    
    // Fallback for non-secure contexts (HTTP LAN)
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.left = "-999999px";
    textArea.style.top = "-999999px";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
        document.execCommand('copy');
    } catch (err) {
        console.error('Fallback copy failed', err);
        alert("Clipboard copy is restricted on this browser/connection. Please use Desktop or HTTPS.");
    }
    document.body.removeChild(textArea);
}

async function copyBatch(startParagraph, formatted = false) {
    // If formatted (Export), we keep annotations. If not (Copy), we strip them.
    const content = parseHTMLToNotas(getBatchHTML(startParagraph), !formatted);
    const text = formatted 
        ? `Ajuste essa parte do capítulo abaixo de acordo com as notas que eu inseri:\n\n\n"""\n${content}\n"""`
        : content;
    await copyToClipboard(text);
}

function exportBatch(num, startParagraph) {
    const text = parseHTMLToNotas(getBatchHTML(startParagraph));
    downloadFile(`${currentFileName.replace(/\.[^/.]+$/, "")}-Part${num}.md`, text);
}

// --- Selection & Note UI ---

document.addEventListener('selectionchange', () => {
    const selection = window.getSelection();
    if (!selection.isCollapsed && editor.contains(selection.anchorNode)) {
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        floatBtn.style.left = `${rect.left + (rect.width / 2) - 40}px`;
        floatBtn.style.top = `${window.scrollY + rect.top - 40}px`;
        floatBtn.classList.remove('hidden');
    } else { floatBtn.classList.add('hidden'); }
});

floatBtn.addEventListener('click', () => {
    floatBtn.classList.add('hidden');
    activeMarkElement = null; noteInput.value = ''; noteDeleteBtn.classList.add('hidden');
    const selection = window.getSelection();
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    notePopup.style.left = `${rect.left}px`;
    notePopup.style.top = `${window.scrollY + rect.bottom + 10}px`;
    notePopup.classList.remove('hidden');
    noteInput.focus();
    window.savedRange = range;
});

function attemptSaveNote() {
    if (notePopup.classList.contains('hidden')) return;
    const text = noteInput.value.trim();
    if (!text) { closeNotePopup(); return; }
    if (activeMarkElement) activeMarkElement.setAttribute('data-note', text);
    else if (window.savedRange) {
        const selection = window.getSelection();
        selection.removeAllRanges(); selection.addRange(window.savedRange);

        const range = window.savedRange;
        try {
            // Try simple surround first (for single node)
            const mark = document.createElement('mark');
            mark.className = 'note-highlight';
            mark.setAttribute('data-note', text);
            range.surroundContents(mark);
        } catch (e) {
            // Multi-node/Multi-paragraph fallback
            // Use execCommand to create spans, then convert to marks
            // This is the most robust way to handle browser range complexities
            document.execCommand('hiliteColor', false, '#ffff00');
            const spans = editor.querySelectorAll('span[style*="background-color"]');
            spans.forEach(span => {
                const mark = document.createElement('mark');
                mark.className = 'note-highlight';
                mark.setAttribute('data-note', text);
                mark.innerHTML = span.innerHTML;
                span.parentNode.replaceChild(mark, span);
            });
        }
        selection.removeAllRanges();
    }
    closeNotePopup(); triggerAutoBackup();
}


noteSaveBtn.addEventListener('click', attemptSaveNote);
noteDeleteBtn.addEventListener('click', () => {
    if (activeMarkElement) {
        const parent = activeMarkElement.parentNode;
        while (activeMarkElement.firstChild) parent.insertBefore(activeMarkElement.firstChild, activeMarkElement);
        parent.removeChild(activeMarkElement);
        parent.normalize();
    }
    closeNotePopup(); triggerAutoBackup();
});
noteCancelBtn.addEventListener('click', closeNotePopup);
function closeNotePopup() { notePopup.classList.add('hidden'); activeMarkElement = null; window.savedRange = null; }

editor.addEventListener('mouseover', (e) => {
    const mark = e.target.closest('.note-highlight');
    if (mark) {
        tooltip.textContent = mark.getAttribute('data-note');
        const rect = mark.getBoundingClientRect();
        tooltip.style.left = `${rect.left}px`;
        tooltip.style.top = `${window.scrollY + rect.bottom + 5}px`;
        tooltip.classList.remove('hidden');
    }
});
editor.addEventListener('mouseout', (e) => { 
    if (e.target.closest('.note-highlight')) tooltip.classList.add('hidden'); 
});
editor.addEventListener('click', (e) => {
    const mark = e.target.closest('.note-highlight');
    if (mark) {
        activeMarkElement = mark;
        noteInput.value = activeMarkElement.getAttribute('data-note');
        noteDeleteBtn.classList.remove('hidden');
        const rect = activeMarkElement.getBoundingClientRect();
        notePopup.style.left = `${rect.left}px`;
        notePopup.style.top = `${window.scrollY + rect.bottom + 10}px`;
        notePopup.classList.remove('hidden');
        tooltip.classList.add('hidden');
        e.stopPropagation();
    }
});

document.addEventListener('mousedown', (e) => {
    if (!notePopup.contains(e.target) && !notePopup.classList.contains('hidden')) attemptSaveNote();
});

// --- Auto Backup & Sync ---

async function saveToServer(filename, content) {
    try {
        const response = await fetch('/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename, content })
        });
        updateServerStatus(response.ok);
    } catch (e) {
        updateServerStatus(false);
        console.error("Local server save failed:", e);
    }
}


function triggerAutoBackup() {
    console.log("Auto-backup triggered...");
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
        if (editor.classList.contains('hidden')) return;

        const cleanText = parseHTMLToNotas(editor.innerHTML, false);
        if (!cleanText && editor.textContent.trim() === "") return;
        
        // Only save if the content has actually changed
        if (cleanText === lastSavedContent) {
            console.log("No changes detected, skipping sync.");
            return;
        }

        const allParagraphs = Array.from(editor.querySelectorAll('p'));
        
        let validIndex = 0;
        const splitIndices = [];
        const doneIndices = [];
        
        allParagraphs.forEach(p => {
            let s = p.innerHTML;
            s = s.replace(/<br\s*\/?>/gi, '\n');
            s = s.replace(/<(?!\/?nota\b)[^>]+>/gi, '');
            s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
            
            if (s.length > 0) {
                if (p.classList.contains('batch-split')) splitIndices.push(validIndex);
                if (p.classList.contains('batch-done')) doneIndices.push(validIndex);
                validIndex++;
            }
        });

        // 1. Always backup to LocalStorage for safety
        try {
            localStorage.setItem('novel_editor_backup_text', cleanText);
            localStorage.setItem('novel_editor_backup_splits', JSON.stringify(splitIndices));
            localStorage.setItem('novel_editor_backup_done', JSON.stringify(doneIndices));
            localStorage.setItem('novel_editor_backup_filename', currentFileName);
            // Save scroll position for this specific file
            localStorage.setItem(`novel_editor_scroll_${currentFileName}`, editorWrapper.scrollTop);
        } catch (e) { }

        // 2. Sync to Local Server (Only active on desktop PC)
        if (!isMobile) {
            const originalName = currentFileName.replace('Backup - ', '').replace('Live - ', '');

            // Prepare Metadata Header
            const metadata = {
                filename: originalName,
                splits: splitIndices,
                done: doneIndices,
                timestamp: Date.now()
            };

            // Save Master Backup (Metadata + Text with Annotations)
            const backupContent = `<!-- ${JSON.stringify(metadata)} -->\n\n${cleanText}`;
            saveToServer(`Backup - ${originalName}`, backupContent);

            // Save Live Copy (Clean Text only)
            const cleanTextOnly = parseHTMLToNotas(editor.innerHTML, true);
            saveToServer(`Live - ${originalName}`, cleanTextOnly);
            console.log("Desktop sync complete (Backup & Live).");
        } else {
            console.log("Mobile offline mode: auto-backup saved locally.");
        }

        lastSavedContent = cleanText;
    }, 5000); // Increased to 5 seconds to prevent cloud sync conflicts
}




editor.addEventListener('input', (e) => {
    // 1. Live Markdown Highlighting (Only for the current paragraph)
    const selection = window.getSelection();
    if (selection.rangeCount > 0) {
        let node = selection.anchorNode;
        while (node && node !== editor && node.nodeName !== 'P') {
            node = node.parentNode;
        }
        if (node && node.nodeName === 'P' && !node.classList.contains('gutter-batch')) {
            applyMarkdownHighlight(node);
        }
    }

    triggerAutoBackup();
    refreshSplitsUI();
});

function applyMarkdownHighlight(p) {
    const temp = document.createElement('div');
    temp.innerHTML = p.innerHTML;
    let mdSpans = temp.querySelectorAll('span[class*="md-"]');
    
    // Only highlight if there are asterisks, or if we have existing spans to clean up
    if (!/\*/.test(p.textContent) && mdSpans.length === 0) return;

    const selection = window.getSelection();
    const hasSelection = selection.rangeCount > 0 && p.contains(selection.anchorNode);
    
    let caretOffset = 0;
    if (hasSelection) {
        const range = selection.getRangeAt(0);
        const preCaretRange = range.cloneRange();
        preCaretRange.selectNodeContents(p);
        preCaretRange.setEnd(range.endContainer, range.endOffset);
        caretOffset = preCaretRange.toString().length;
    }

    // Safely unwrap all existing markdown spans to get a clean slate
    while (mdSpans.length > 0) {
        mdSpans.forEach(span => {
            span.outerHTML = span.innerHTML;
        });
        mdSpans = temp.querySelectorAll('span[class*="md-"]');
    }
    
    let content = temp.innerHTML;
    
    // Bold: **text**
    content = content.replace(/\*\*(.*?)\*\*/g, '<span class="md-symbol">**</span><span class="md-bold">$1</span><span class="md-symbol">**</span>');
    
    // Italic: *text* (avoiding double-processing bold symbols, must have non-space adjacent to stars)
    content = content.replace(/(?<!\*)\*(?=\S)(.+?)(?<=\S)\*(?!\*)/g, '<span class="md-symbol">*</span><span class="md-italic">$1</span><span class="md-symbol">*</span>');

    if (p.innerHTML !== content) {
        p.innerHTML = content;
        if (hasSelection) {
            restoreCaret(p, caretOffset);
        }
    }
}

function restoreCaret(el, offset) {
    const range = document.createRange();
    const sel = window.getSelection();
    let charCount = 0;
    let found = false;

    function traverse(node) {
        if (found) return;
        if (node.nodeType === 3) {
            const nextCount = charCount + node.length;
            if (offset <= nextCount) {
                range.setStart(node, offset - charCount);
                range.collapse(true);
                found = true;
            }
            charCount = nextCount;
        } else {
            for (let i = 0; i < node.childNodes.length; i++) {
                traverse(node.childNodes[i]);
            }
        }
    }

    traverse(el);
    if (found) {
        sel.removeAllRanges();
        sel.addRange(range);
    }
}

window.addEventListener('resize', () => renderGutter());

// Gutter Hover State
gutter.addEventListener('mouseenter', () => {
    const manuscript = document.querySelector('.manuscript-container');
    if (manuscript) manuscript.classList.add('gutter-active');
});
gutter.addEventListener('mouseleave', () => {
    const manuscript = document.querySelector('.manuscript-container');
    if (manuscript) manuscript.classList.remove('gutter-active');
});


// --- Drag & Drop ---

document.addEventListener('dragenter', (e) => { e.preventDefault(); dropOverlay.classList.remove('hidden'); });
document.addEventListener('dragover', (e) => { e.preventDefault(); dropOverlay.classList.remove('hidden'); });
document.addEventListener('dragleave', (e) => { e.preventDefault(); if (e.relatedTarget === null || e.relatedTarget.nodeName === 'HTML') dropOverlay.classList.add('hidden'); });
document.addEventListener('drop', async (e) => {
    e.preventDefault(); dropOverlay.classList.add('hidden');
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        const fileName = file.name;
        const isSessionFile = fileName.startsWith('Backup - ');
        const isLiveFile = fileName.startsWith('Live - ');
        const originalName = fileName.replace('Backup - ', '').replace('Live - ', '');

        let text = await file.text();
        let initialMetadata = null;

        // Check for embedded session data
        if (text.startsWith('<!--')) {
            const metaMatch = text.match(/^<!--\s*(\{.*?\})\s*-->/);
            if (metaMatch) {
                try {
                    initialMetadata = JSON.parse(metaMatch[1]);
                    text = text.replace(metaMatch[0], '').trim();
                } catch (e) { }
            }
        }

        currentFileName = originalName;
        fileNameDisplay.textContent = currentFileName;
        // Recalculate only if it's a brand new file (not Backup or Live)
        const shouldRecalculate = !isSessionFile && !isLiveFile;
        openEditorWithContent(parseNotasToHTML(text), shouldRecalculate, initialMetadata);
    }
});

// --- Select File (Mobile/Universal Input) ---
const openBtn = document.getElementById('open-btn');
const fileInput = document.getElementById('file-input');

if (openBtn && fileInput) {
    openBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async (e) => {
        if (e.target.files && e.target.files.length > 0) {
            const file = e.target.files[0];
            const fileName = file.name;
            const isSessionFile = fileName.startsWith('Backup - ');
            const isLiveFile = fileName.startsWith('Live - ');
            const originalName = fileName.replace('Backup - ', '').replace('Live - ', '');

            let text = await file.text();
            let initialMetadata = null;

            // Check for embedded session data
            if (text.startsWith('<!--')) {
                const metaMatch = text.match(/^<!--\s*(\{.*?\})\s*-->/);
                if (metaMatch) {
                    try {
                        initialMetadata = JSON.parse(metaMatch[1]);
                        text = text.replace(metaMatch[0], '').trim();
                    } catch (e) { }
                }
            }

            currentFileName = originalName;
            fileNameDisplay.textContent = currentFileName;
            // Recalculate only if it's a brand new file (not Backup or Live)
            const shouldRecalculate = !isSessionFile && !isLiveFile;
            openEditorWithContent(parseNotasToHTML(text), shouldRecalculate, initialMetadata);
        }
    });
}




async function setupFileSystemWorkspace(handle) {
    let fileName = handle.name;
    const isBackupFile = fileName.startsWith('Backup - ');
    const originalName = isBackupFile ? fileName.replace('Backup - ', '') : fileName;

    // Request Directory Access (Edge/Chrome requirement to create siblings)
    alert(`To enable automatic saving, please select the folder where ${fileName} is located.`);
    try {
        dirHandle = await window.showDirectoryPicker();

        // Try to get/create the two files
        backupFileHandle = await dirHandle.getFileHandle(`Backup - ${originalName}`, { create: true });
        commentsFileHandle = await dirHandle.getFileHandle(`Comments - ${originalName}`, { create: true });

        let initialText = "";
        let initialSplits = [];

        if (isBackupFile) {
            // Loading existing backup
            const file = await handle.getFile();
            initialText = await file.text();

            // Try to load matching comments
            try {
                const cFile = await commentsFileHandle.getFile();
                const cData = JSON.parse(await cFile.text());
                initialSplits = cData.splits || [];
            } catch (e) { console.log("No existing comments found."); }
        } else {
            // Starting from fresh .md file
            const file = await handle.getFile();
            initialText = await file.text();
            // Initial save to the new backup files
            // This will happen automatically via triggerAutoBackup after load
        }

        currentFileName = originalName;
        fileNameDisplay.textContent = currentFileName;
        openEditorWithContent(parseNotasToHTML(initialText), !isBackupFile, initialSplits);

    } catch (err) {
        console.error("Workspace setup failed:", err);
        // Fallback to old behavior if user cancels
        const file = await handle.getFile();
        const text = await file.text();
        currentFileName = fileName;
        fileNameDisplay.textContent = currentFileName;
        openEditorWithContent(parseNotasToHTML(text), true);
    }
}


// --- Actions ---

function openEditorWithContent(content, recalculateSplits = false, savedSplits = null) {

    // If it's HTML, we might be coming from an old backup or drop
    // If it's Markdown (clean text), we parse it
    let htmlContent = content;
    if (!content.includes('<p>')) {
        // Convert Markdown-ish to paragraphs - split by double or more newlines
        // We filter out empty strings to prevent 'ghost' paragraphs
        htmlContent = content.split(/\r?\n\s*\r?\n/)
            .map(p => p.trim())
            .filter(p => p.length > 0)
            .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
            .join('');
    }


    editor.innerHTML = htmlContent;

    // Apply notes (highlights)
    editor.innerHTML = parseNotasToHTML(editor.innerHTML);

    welcomeScreen.classList.add('hidden');
    editor.classList.remove('hidden');
    gutter.classList.remove('hidden');
    editorHeader.classList.remove('hidden');
    saveBtn.classList.remove('hidden');

    const paragraphs = Array.from(editor.querySelectorAll('p'));

    if (savedSplits) {
        const splits = Array.isArray(savedSplits) ? savedSplits : (savedSplits.splits || []);
        const done = Array.isArray(savedSplits) ? [] : (savedSplits.done || []);

        splits.forEach(idx => {
            if (paragraphs[idx]) paragraphs[idx].classList.add('batch-split');
        });

        done.forEach(idx => {
            if (paragraphs[idx]) paragraphs[idx].classList.add('batch-done');
        });
    }

    // Apply markdown highlighting to all paragraphs
    paragraphs.forEach(p => applyMarkdownHighlight(p));


    if (recalculateSplits) {
        updateBatchGuidelines(true);
    } else {
        refreshSplitsUI();
    }

    // Restore scroll position
    const savedScroll = localStorage.getItem(`novel_editor_scroll_${currentFileName}`);
    if (savedScroll) {
        setTimeout(() => {
            editorWrapper.scrollTop = parseInt(savedScroll);
        }, 100);
    }

    editor.focus();
    triggerAutoBackup();
}

restoreBtn.addEventListener('click', () => {
    const backupText = localStorage.getItem('novel_editor_backup_text');
    const backupSplits = localStorage.getItem('novel_editor_backup_splits');
    const backupName = localStorage.getItem('novel_editor_backup_filename');
    const oldBackup = localStorage.getItem('novel_editor_backup_content');

    if (backupText !== null) {
        currentFileName = backupName || "restored.md";
        fileNameDisplay.textContent = currentFileName;
        const splits = backupSplits ? JSON.parse(backupSplits) : [];
        const done = localStorage.getItem('novel_editor_backup_done') ? JSON.parse(localStorage.getItem('novel_editor_backup_done')) : [];
        openEditorWithContent(backupText, false, { splits, done });
    } else if (oldBackup !== null) {
        currentFileName = backupName || "restored.md";
        fileNameDisplay.textContent = currentFileName;
        openEditorWithContent(oldBackup, false);
    }
});

function downloadFile(name, text) {
    const blob = new Blob([text], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

saveBtn.addEventListener('click', () => {
    const allParagraphs = Array.from(editor.querySelectorAll('p'));
    let validIndex = 0;
    const splitIndices = [];
    const doneIndices = [];
    allParagraphs.forEach(p => {
        let s = p.innerHTML;
        s = s.replace(/<br\s*\/?>/gi, '\n');
        s = s.replace(/<(?!\/?nota\b)[^>]+>/gi, '');
        s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
        if (s.length > 0) {
            if (p.classList.contains('batch-split')) splitIndices.push(validIndex);
            if (p.classList.contains('batch-done')) doneIndices.push(validIndex);
            validIndex++;
        }
    });

    const originalName = currentFileName.replace('Backup - ', '').replace('Live - ', '');
    const metadata = {
        filename: originalName,
        splits: splitIndices,
        done: doneIndices,
        timestamp: Date.now()
    };
    const text = parseHTMLToNotas(editor.innerHTML, false);
    const backupContent = `<!-- ${JSON.stringify(metadata)} -->\n\n${text}`;
    downloadFile(`Backup - ${originalName}`, backupContent);
});

globalExportBtn.addEventListener('click', () => {
    const originalName = currentFileName.replace('Backup - ', '').replace('Live - ', '');
    downloadFile(`Live - ${originalName}`, parseHTMLToNotas(editor.innerHTML, true));
});
globalCopyBtn.addEventListener('click', async () => {
    await copyToClipboard(parseHTMLToNotas(editor.innerHTML, false));
});

themeToggle.addEventListener('click', () => {
    document.body.classList.toggle('theme-dark');
    document.body.classList.toggle('theme-light');
});
zoomInBtn.addEventListener('click', () => { if (currentFontSize < 3) { setEditorFontSize(currentFontSize + 0.1); renderGutter(); } });
zoomOutBtn.addEventListener('click', () => { if (currentFontSize > 0.8) { setEditorFontSize(currentFontSize - 0.1); renderGutter(); } });

if (undoBtn) undoBtn.addEventListener('click', () => { document.execCommand('undo'); editor.focus(); });
if (redoBtn) redoBtn.addEventListener('click', () => { document.execCommand('redo'); editor.focus(); });
