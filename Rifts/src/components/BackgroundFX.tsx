'use client';

import React, { useCallback, useMemo } from 'react';
import Particles from "@tsparticles/react";
import { loadSlim } from "@tsparticles/slim";
import type { Engine } from "@tsparticles/engine";

const BackgroundFX: React.FC = () => {
    const particlesInit = useCallback(async (engine: Engine) => {
        await loadSlim(engine);
    }, []);

    const particlesOptions = useMemo(() => ({
        background: {
            color: {
                value: '#000000',
            },
        },
        fpsLimit: 60,
        particles: {
            number: {
                value: 100,
                density: {
                    enable: true,
                    value_area: 800,
                },
            },
            color: {
                value: '#10b981',
            },
            shape: {
                type: 'circle',
            },
            opacity: {
                value: 0.1,
                random: true,
            },
            size: {
                value: 2,
                random: true,
            },
            move: {
                enable: true,
                speed: 0.2,
                direction: 'top' as const,
                straight: true,
            },
        },
        interactivity: {
            detectsOn: 'canvas' as const,
            events: {
                onhover: {
                    enable: true,
                    mode: 'repulse',
                },
                resize: {
                    enable: true
                },
            },
            modes: {
                repulse: {
                    distance: 50,
                    duration: 0.4,
                },
            },
        },
        detectRetina: true,
    }), []);

    return (
        <div className="fixed inset-0 opacity-50 -z-10">
            <Particles
                id="tsparticles"
                options={particlesOptions}
            />
        </div>
    );
};

export default BackgroundFX;