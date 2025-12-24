"use client";
import { cn } from "@/lib/utils";
import React, { useState, createContext, useContext } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { IconMenu2, IconX } from "@tabler/icons-react";
import Image from "next/image";

interface Links {
  label: string;
  href: string;
  icon: React.JSX.Element | React.ReactNode;
}

interface SidebarContextProps {
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  animate: boolean;
}

const SidebarContext = createContext<SidebarContextProps | undefined>(
  undefined
);

export const useSidebar = () => {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider");
  }
  return context;
};

export const SidebarProvider = ({
  children,
  open: openProp,
  setOpen: setOpenProp,
  animate = true,
}: {
  children: React.ReactNode;
  open?: boolean;
  setOpen?: React.Dispatch<React.SetStateAction<boolean>>;
  animate?: boolean;
}) => {
  const [openState, setOpenState] = useState(false);

  const open = openProp !== undefined ? openProp : openState;
  const setOpen = setOpenProp !== undefined ? setOpenProp : setOpenState;

  return (
    <SidebarContext.Provider value={{ open, setOpen, animate: animate }}>
      {children}
    </SidebarContext.Provider>
  );
};

export const Sidebar = ({
  children,
  open,
  setOpen,
  animate,
}: {
  children: React.ReactNode;
  open?: boolean;
  setOpen?: React.Dispatch<React.SetStateAction<boolean>>;
  animate?: boolean;
}) => {
  return (
    <SidebarProvider open={open} setOpen={setOpen} animate={animate}>
      {children}
    </SidebarProvider>
  );
};

export const SidebarBody = (props: React.ComponentProps<typeof motion.div>) => {
  const { className, children } = props;
  return (
    <>
      <MobileSidebar className={className}>{children as React.ReactNode}</MobileSidebar>
      <DesktopSidebar {...props} />
    </>
  );
};

export const DesktopSidebar = ({
  className,
  children,
  ...props
}: React.ComponentProps<typeof motion.div>) => {
  const { open, setOpen, animate } = useSidebar();
  const [isHovered, setIsHovered] = useState(false);
  
  return (
    <>
      <motion.div
        className={cn(
          "h-full flex flex-col w-[180px] shrink-0 relative overflow-hidden",
          // Mobile: Absolute positioning to overlay content
          "fixed md:relative inset-y-0 left-0 z-50 md:z-auto",
          // Hide on mobile when closed, always show on desktop
          open ? "translate-x-0" : "-translate-x-full md:translate-x-0",
          "transition-transform duration-300 ease-in-out",
          // Luxury glass background with emerald accents
          "bg-black/80 backdrop-blur-xl border-r border-emerald-500/20",
          // Premium shadows and effects
          "shadow-[0_0_50px_rgba(0,0,0,0.8)] shadow-emerald-500/10",
          className
        )}
        animate={{
          width: animate ? (open ? "180px" : "56px") : "180px",
        }}
        onMouseEnter={() => {
          setOpen(true);
          setIsHovered(true);
        }}
        onMouseLeave={() => {
          setOpen(false);
          setIsHovered(false);
        }}
        {...props}
      >
        {/* Luxury background patterns */}
        <div className="absolute inset-0 opacity-30">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(16,185,129,0.15)_0%,transparent_50%)]" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_80%,rgba(16,185,129,0.1)_0%,transparent_50%)]" />
        </div>

        {/* Animated border glow */}
        <motion.div
          className="absolute inset-0 opacity-0"
          animate={{
            opacity: isHovered ? 1 : 0,
          }}
          transition={{ duration: 0.5 }}
        >
          <div className="absolute inset-0 bg-emerald-500/5 border-r-2 border-emerald-400/30" />
          <div className="absolute top-0 right-0 h-full w-[1px] bg-gradient-to-b from-emerald-400/50 via-emerald-500/30 to-transparent" />
        </motion.div>

        {/* Premium mesh gradient overlay */}
        <div className="absolute inset-0 opacity-20">
          <div className="absolute inset-0 bg-gradient-to-b from-emerald-500/10 via-transparent to-black/20" />
        </div>

        {/* Content with ultra-compact spacing */}
        <div className="relative z-10 h-full flex flex-col px-2 py-2">
          {children as React.ReactNode}
        </div>

        {/* Corner accents - luxury details */}
        <div className="absolute top-0 right-0 w-3 h-3 border-t-2 border-r-2 border-emerald-500/40" />
        <div className="absolute bottom-0 right-0 w-3 h-3 border-b-2 border-r-2 border-emerald-500/40" />
      </motion.div>
      
      {/* Mobile Overlay */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm md:hidden"
          onClick={() => setOpen(false)}
        />
      )}
    </>
  );
};

export const MobileSidebar = ({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) => {
  const { open, setOpen } = useSidebar();
  return (
    <>
      <div
        className={cn(
          "h-16 px-4 py-2 flex flex-row md:hidden items-center justify-between",
          "bg-black/90 backdrop-blur-xl border-b border-emerald-500/20",
          "shadow-[0_0_30px_rgba(0,0,0,0.8)] shadow-emerald-500/10 w-full",
          "fixed top-0 left-0 right-0 z-50"
        )}
        {...props}
      >
        <div className="flex justify-end z-20 w-full">
          <motion.div
            whileHover={{ scale: 1.1, rotate: 180 }}
            whileTap={{ scale: 0.9 }}
            className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 hover:bg-emerald-500/20 transition-all duration-300"
          >
            <IconMenu2
              className="text-emerald-400 w-6 h-6"
              onClick={() => setOpen(!open)}
            />
          </motion.div>
        </div>
        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ x: "-100%", opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: "-100%", opacity: 0 }}
              transition={{
                duration: 0.4,
                ease: [0.25, 0.46, 0.45, 0.94],
              }}
              className={cn(
                "fixed h-full w-full inset-0 z-[100] flex flex-col justify-between",
                "bg-black/95 backdrop-blur-2xl p-8",
                "border-r border-emerald-500/20 shadow-[0_0_100px_rgba(16,185,129,0.1)]",
                className
              )}
            >
              {/* Luxury background patterns for mobile */}
              <div className="absolute inset-0 opacity-20">
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(16,185,129,0.2)_0%,transparent_50%)]" />
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_80%,rgba(16,185,129,0.15)_0%,transparent_50%)]" />
              </div>

              <motion.div
                className="absolute right-8 top-8 z-50 p-2 rounded-lg bg-red-500/10 border border-red-500/30 hover:bg-red-500/20 transition-all duration-300"
                onClick={() => setOpen(!open)}
                whileHover={{ scale: 1.1, rotate: 180 }}
                whileTap={{ scale: 0.9 }}
              >
                <IconX className="text-red-400 w-6 h-6" />
              </motion.div>
              
              <div className="relative z-10">
                {children}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  );
};

export const SidebarLink = ({
  link,
  className,
  ...props
}: {
  link: Links;
  className?: string;
}) => {
  const { open, animate } = useSidebar();
  const [isHovered, setIsHovered] = useState(false);
  
  return (
    <motion.a
      href={link.href}
      className={cn(
        "flex items-center justify-start gap-1.5 group/sidebar relative overflow-hidden",
        "p-1.5 rounded-md transition-all duration-300 cursor-pointer",
        "hover:bg-emerald-500/10 hover:border-emerald-400/30 hover:shadow-lg hover:shadow-emerald-500/20",
        "border border-transparent backdrop-blur-sm",
        "text-gray-300 hover:text-emerald-300",
        className
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      whileHover={{ 
        scale: 1.02,
        x: 4
      }}
      whileTap={{ scale: 0.98 }}
      transition={{ type: "spring", stiffness: 300, damping: 25 }}
      {...props}
    >
      {/* Luxury shine effect */}
      <motion.div
        className="absolute inset-0 -skew-x-12 bg-gradient-to-r from-transparent via-emerald-300/20 to-transparent"
        initial={{ x: '-200%' }}
        animate={{
          x: isHovered ? '200%' : '-200%',
        }}
        transition={{ duration: 0.6, ease: "easeOut" }}
      />

      {/* Icon with premium styling */}
      <motion.div
        className="relative z-10 flex items-center justify-center w-6 h-6 rounded-md bg-emerald-500/10 border border-emerald-500/20 shrink-0"
        animate={{
          backgroundColor: isHovered ? 'rgba(16, 185, 129, 0.2)' : 'rgba(16, 185, 129, 0.1)',
          borderColor: isHovered ? 'rgba(16, 185, 129, 0.4)' : 'rgba(16, 185, 129, 0.2)',
        }}
        transition={{ duration: 0.3 }}
      >
        <motion.div
          animate={{
            scale: isHovered ? 1.1 : 1,
            rotate: isHovered ? 5 : 0,
          }}
          transition={{ type: "spring", stiffness: 300 }}
        >
          {link.icon}
        </motion.div>
      </motion.div>

      <motion.span
        animate={{
          display: animate ? (open ? "inline-block" : "none") : "inline-block",
          opacity: animate ? (open ? 1 : 0) : 1,
        }}
        className="relative z-10 text-xs font-medium tracking-wide uppercase whitespace-pre inline-block !p-0 !m-0 transition-colors duration-300"
      >
        {link.label}
        {/* Underline effect */}
        <motion.div
          className="absolute bottom-0 left-0 right-0 h-[1px] bg-emerald-400 origin-left"
          initial={{ scaleX: 0 }}
          animate={{ scaleX: isHovered && open ? 1 : 0 }}
          transition={{ duration: 0.3 }}
        />
      </motion.span>

      {/* Corner accents */}
      <motion.div 
        className="absolute top-1 left-1 w-2 h-2 border-t border-l border-emerald-400/0"
        animate={{
          borderColor: isHovered ? 'rgba(16, 185, 129, 0.6)' : 'rgba(16, 185, 129, 0)',
        }}
        transition={{ duration: 0.3 }}
      />
      <motion.div 
        className="absolute bottom-1 right-1 w-2 h-2 border-b border-r border-emerald-400/0"
        animate={{
          borderColor: isHovered ? 'rgba(16, 185, 129, 0.6)' : 'rgba(16, 185, 129, 0)',
        }}
        transition={{ duration: 0.3 }}
      />
    </motion.a>
  );
};