
export interface ReviewState {
    blockNext: boolean;
}

export interface Finding {
    critical?: boolean;
    [key: string]: any;
}

export const applyFindings = (currentState: ReviewState, findings: Finding[]): ReviewState => {
    const hasCriticalFinding = findings.some(finding => finding.critical === true);
    if (currentState.blockNext === true && !hasCriticalFinding) {
        return { ...currentState };
    }

    if (hasCriticalFinding) {
        return { ...currentState, blockNext: true };
    }
    return { ...currentState };
};

export const clearBlock = (currentState: ReviewState): ReviewState => {
    return { ...currentState, blockNext: false };
};
