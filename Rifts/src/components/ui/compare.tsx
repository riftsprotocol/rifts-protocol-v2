"use client";
import React, { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";

export interface CompareProps {
  firstImage: string;
  secondImage: string;
  firstImageClassName?: string;
  secondImageClassName?: string;
  className?: string;
  slideMode?: "hover" | "drag";
  showHandlebar?: boolean;
  autoplay?: boolean;
  autoplayDuration?: number;
}

export const Compare = ({
  firstImage,
  secondImage,
  firstImageClassName,
  secondImageClassName,
  className,
  slideMode = "hover",
  showHandlebar = true,
  autoplay = false,
  autoplayDuration = 5000,
}: CompareProps) => {
  const [sliderXPercent, setSliderXPercent] = useState(50);
  const [isDragging, setIsDragging] = useState(false);

  const sliderRef = useRef<HTMLDivElement>(null);

  const [isMouseOver, setIsMouseOver] = useState(false);

  const autoplayRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (autoplay) {
      autoplayRef.current = setInterval(() => {
        if (!isMouseOver && !isDragging) {
          setSliderXPercent((prev) => {
            const increment = 2;
            if (prev >= 95) {
              return 5;
            }
            return prev + increment;
          });
        }
      }, autoplayDuration / 50);
    }

    return () => {
      if (autoplayRef.current) {
        clearInterval(autoplayRef.current);
      }
    };
  }, [autoplay, autoplayDuration, isMouseOver, isDragging]);

  const handleMove = (clientX: number) => {
    if (!sliderRef.current) return;
    const rect = sliderRef.current.getBoundingClientRect();
    const x = clientX - rect.left;
    const percent = (x / rect.width) * 100;
    setSliderXPercent(Math.max(0, Math.min(100, percent)));
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (slideMode === "hover") {
      handleMove(e.clientX);
    } else if (slideMode === "drag" && isDragging) {
      handleMove(e.clientX);
    }
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (slideMode === "drag") {
      setIsDragging(true);
      handleMove(e.clientX);
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  useEffect(() => {
    const handleGlobalMouseUp = () => setIsDragging(false);
    if (isDragging) {
      window.addEventListener("mouseup", handleGlobalMouseUp);
    }
    return () => window.removeEventListener("mouseup", handleGlobalMouseUp);
  }, [isDragging]);

  return (
    <div
      ref={sliderRef}
      className={`w-[400px] h-[400px] overflow-hidden rounded-xl relative cursor-grab active:cursor-grabbing ${className}`}
      style={{
        aspectRatio: "1/1",
      }}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setIsMouseOver(false)}
      onMouseEnter={() => setIsMouseOver(true)}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
    >
      <motion.div
        className="h-full w-px bg-white z-30 absolute top-0"
        style={{
          left: `${sliderXPercent}%`,
          top: 0,
          zIndex: 40,
        }}
        initial={false}
      >
        {showHandlebar && (
          <div className="w-5 h-5 bg-white rounded-full absolute top-1/2 transform -translate-y-1/2 -translate-x-1/2 flex items-center justify-center z-30">
            <div className="w-2 h-2 bg-black rounded-full" />
          </div>
        )}
      </motion.div>

      <div className="overflow-hidden w-full h-full relative z-20 pointer-events-none">
        <div
          className="absolute inset-0 z-20 rounded-2xl overflow-hidden"
          style={{
            clipPath: `inset(0 ${100 - sliderXPercent}% 0 0)`,
          }}
        >
          <img
            alt="first image"
            src={firstImage}
            className={`absolute inset-0 z-20 rounded-2xl object-cover w-full h-full select-none ${firstImageClassName}`}
            draggable={false}
          />
        </div>
      </div>

      <div className="overflow-hidden w-full h-full absolute z-10 inset-0">
        <img
          alt="second image"
          src={secondImage}
          className={`absolute inset-0 z-10 rounded-2xl object-cover w-full h-full select-none ${secondImageClassName}`}
          draggable={false}
        />
      </div>
    </div>
  );
};